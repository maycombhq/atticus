package com.maycombhq.atticus.core

/** One step of `atticus next --json`. */
data class NextStep(
    val step: String,
    val command: String,
    val why: String,
    val slash: String? = null,
    val where: String? = null,
    val person: Boolean = false,
    val repo: String? = null,
    val change: String? = null,
    val source: String? = null,
    /** The kind of AI step (ADR 0121 addendum): read, draft, critic, knowledge or quick. */
    val stepClass: String? = null,
)

/**
 * [runs] says in one line what runs a step here (ADR 0121 item 6); [modelMode] whether a step can
 * run on runtime.yaml's model, so "Run on Atticus's configured model" is offered; [orgModels]
 * runtime.yaml's model for each kind of step it names one for (its addendum).
 */
data class NextView(
    val next: NextStep?,
    val steps: List<NextStep>,
    val runs: String? = null,
    val modelMode: Boolean = false,
    val orgModels: Map<String, String> = emptyMap(),
)

/** What the plugin does for a step `atticus next` names. */
sealed interface NextAction {
    /** An AI step: run it in Copilot Chat with [slash], or its hand-off in a console. */
    data class Ai(val args: List<String>, val slash: String?) : NextAction

    /** Questions wait for a person: answer them in the app, or with [slash] in Copilot Chat. */
    data class Answer(val slash: String?) : NextAction

    /** A command to run, through the same rules as Run a command. */
    data class Run(val args: List<String>) : NextAction

    /** A step only a person takes, or a command with a part to fill in: shown, not run. */
    data class Person(val command: String) : NextAction

    /**
     * ADR 0156: a repo's starting spec to accept before [change]'s stories run again. A person
     * reads the seed first; then `atticus spec accept <repo>` runs when they say so.
     */
    data class AcceptSeed(val repo: String, val change: String?, val command: String) : NextAction
}

/**
 * F5: a repo with no facts whose id is near one that has some (`atticus next` says so in its why):
 * likely one repo under two ids, kept as one with `atticus repo rename <repo> <near>`.
 */
data class NearId(val repo: String, val near: String, val file: String) {
    val rename: List<String> get() = listOf("repo", "rename", repo, near)
}

/** What a repo's read is estimated to cost and what it took (ADR 0141), each said for what it is. */
data class ReadCost(
    val estimatedTokens: Long? = null,
    val estimatedSessions: Int? = null,
    val partsRead: Int = 0,
    val partsOf: Int = 1,
    val reportedTokens: Long? = null,
    val reportedSessions: Int? = null,
) {
    /** In words: the estimate, the parts read, and what the assistant reported, each named. */
    val words: String
        get() =
            listOfNotNull(
                estimatedTokens?.let { Copy.costEstimated(Queue.tokens(it), estimatedSessions ?: 1) },
                if (partsOf > 1 || partsRead > 0) Copy.partsRead(partsRead, partsOf) else null,
                reportedTokens?.let { Copy.costReported(Queue.tokens(it), reportedSessions) },
            ).joinToString(" · ")
}

/** A repo waiting to be read, in the onboarding queue's order (`atticus next --queue --json`). */
data class QueueRow(val repo: String, val order: Int, val reason: String, val why: String, val command: String, val slash: String?, val cost: ReadCost?) {
    val detail: String get() = listOfNotNull(Copy.queueReason(reason), cost?.words?.takeIf { it.isNotEmpty() } ?: Copy.COST_NOT_ESTIMATED).joinToString(" · ")

    /** The read as a step of `atticus next`, so it is taken as the Next tab takes one. */
    val step: NextStep get() = NextStep(step = "map", command = command, why = why, slash = slash, where = "metarepo", repo = repo, stepClass = "read")
}

/** A repo read so far, with what its read took, and whether its clone moved past its facts. */
data class ReadRow(val repo: String, val cost: ReadCost?, val stale: Boolean) {
    val detail: String
        get() = listOfNotNull(cost?.words?.takeIf { it.isNotEmpty() } ?: Copy.NO_COST_ON_FILE, if (stale) Copy.STALE_CLONE else null).joinToString(" · ")
}

data class QueueView(val queue: List<QueueRow>, val read: List<ReadRow>)

/** `atticus next --queue --json` (ADR 0141): the order to read in, why, and what each read costs. */
object Queue {
    fun parse(json: String): QueueView? {
        val root = runCatching { Json.objectIn(json) }.getOrNull().obj() ?: return null
        val queue =
            root.objs("queue").mapNotNull { q ->
                val repo = q.str("repo") ?: return@mapNotNull null
                QueueRow(
                    repo = repo,
                    order = (q["order"] as? Number)?.toInt() ?: 0,
                    reason = q.str("reason") ?: "next",
                    why = q.str("why") ?: "",
                    command = q.str("command") ?: "atticus map $repo",
                    slash = q.str("slash"),
                    cost = cost(q["cost"].obj()),
                )
            }.sortedBy { it.order }
        val read = root.objs("read").mapNotNull { r -> r.str("repo")?.let { ReadRow(it, cost(r["cost"].obj()), r["stale"].obj() != null) } }
        return QueueView(queue, read)
    }

    private fun cost(c: Map<*, *>?): ReadCost? {
        if (c == null) return null
        val e = c["estimated"].obj()
        val r = c["read"].obj()
        val rep = c["reported"].obj()
        return ReadCost(
            estimatedTokens = (e?.get("tokens") as? Number)?.toLong(),
            estimatedSessions = (e?.get("sessions") as? Number)?.toInt(),
            partsRead = (r?.get("parts") as? Number)?.toInt() ?: 0,
            partsOf = (r?.get("of") as? Number)?.toInt() ?: 1,
            reportedTokens = (rep?.get("tokens") as? Number)?.toLong(),
            reportedSessions = (rep?.get("sessions") as? Number)?.toInt(),
        )
    }

    /** A token count as the command line says it: 61K, 1.2M. */
    fun tokens(n: Long): String =
        when {
            n >= 1_000_000 -> String.format(java.util.Locale.ROOT, "%.1f", n / 1_000_000.0).removeSuffix(".0") + "M"
            n >= 1000 -> "${Math.round(n / 1000.0)}K"
            else -> n.toString()
        }
}

object Next {
    /** Read `atticus next --json`; null when it printed no JSON (not a metarepo, say). */
    fun parse(json: String): NextView? {
        val root = runCatching { Json.objectIn(json) }.getOrNull().obj() ?: return null
        val org = root["orgModels"].obj()?.entries?.mapNotNull { (k, v) -> if (k is String && v is String) k to v else null }?.toMap().orEmpty()
        return NextView(root["next"].obj()?.let(::step), root.objs("steps").map(::step), root.str("runs"), root.bool("modelMode"), org)
    }

    private fun step(m: Map<*, *>) =
        NextStep(
            step = m.str("step") ?: "",
            command = m.str("command") ?: "",
            why = m.str("why") ?: "",
            slash = m.str("slash"),
            where = m.str("where"),
            person = m.bool("person"),
            repo = m.str("repo"),
            change = m.str("change"),
            source = m.str("source"),
            stepClass = m.str("stepClass"),
        )

    /** The words of a printed command, without "atticus"; quoted parts kept whole. */
    fun argsOf(command: String): List<String> =
        Regex("\"([^\"]*)\"|'([^']*)'|(\\S+)")
            .findAll(command)
            .map { m -> m.groups[1]?.value ?: m.groups[2]?.value ?: m.groups[3]!!.value }
            .toList()
            .let { if (it.firstOrNull() == "atticus") it.drop(1) else it }

    private val NEAR = Regex("""No facts are filed under (\S+), but (\S+) has some \(([^)]+)\)""")

    /** F5: the near ids `atticus next` names in a step's why, each with the rename that keeps one id. */
    fun nearIds(s: NextStep): List<NearId> = NEAR.findAll(s.why).map { NearId(it.groupValues[1].trimEnd(','), it.groupValues[2], it.groupValues[3]) }.toList()

    fun actionFor(s: NextStep): NextAction {
        if (s.step == "answer") return NextAction.Answer(s.slash)
        // ADR 0156: a person reads the seed, then accepts it here; the change's stories run again after.
        if (s.step == "accept-seed" && s.repo != null) return NextAction.AcceptSeed(s.repo, s.change, s.command)
        if (s.person || Regex("<[^>]+>").containsMatchIn(s.command)) return NextAction.Person(s.command)
        val args = argsOf(s.command)
        // A step atticus next gives a slash command for is an AI step; so is one the plugin knows.
        if (s.slash != null || s.step == "spec" || Commands.isAiStep(args)) {
            return NextAction.Ai(args, s.slash ?: Commands.slashFor(args))
        }
        return NextAction.Run(args)
    }
}
