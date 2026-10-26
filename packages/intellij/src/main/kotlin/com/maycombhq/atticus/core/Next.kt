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

    fun actionFor(s: NextStep): NextAction {
        if (s.step == "answer") return NextAction.Answer(s.slash)
        if (s.person || Regex("<[^>]+>").containsMatchIn(s.command)) return NextAction.Person(s.command)
        val args = argsOf(s.command)
        // A step atticus next gives a slash command for is an AI step; so is one the plugin knows.
        if (s.slash != null || s.step == "spec" || Commands.isAiStep(args)) {
            return NextAction.Ai(args, s.slash ?: Commands.slashFor(args))
        }
        return NextAction.Run(args)
    }
}
