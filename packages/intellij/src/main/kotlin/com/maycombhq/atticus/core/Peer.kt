package com.maycombhq.atticus.core

import java.nio.file.Files
import java.nio.file.Path

/** An archived change near a new one (WP7.6), as `atticus change similar --json` gives it. */
data class PastChangeRow(val id: String, val title: String, val archived: String?)

/** One choice of a question: what it is called and what it means. */
data class QuestionOption(val label: String, val means: String)

/** A question waiting for a person, with its choices and the lines it read. */
data class OpenQuestion(val id: String, val repo: String, val question: String, val options: List<QuestionOption>, val evidence: List<String>)

/** A change with something waiting on a person. */
data class WaitingChange(val id: String, val title: String, val state: String, val openFindings: Int, val blocking: Int, val needs: Int, val manualSteps: Int)

/** What `atticus waiting --json` says waits on people. */
data class WaitingView(val questions: List<OpenQuestion>, val changes: List<WaitingChange>, val knowledgeToVerify: Int)

object Waiting {
    /** Read `atticus waiting --json`; changes with nothing open are left out. Null when it printed no JSON. */
    fun parse(json: String): WaitingView? {
        val root = runCatching { Json.objectIn(json) }.getOrNull().obj() ?: return null
        val other = root["other"].obj()
        val questions = other?.objs("questions").orEmpty().mapNotNull(::question)
        val changes =
            root.objs("changes").mapNotNull { c ->
                val id = c.str("change") ?: return@mapNotNull null
                val open = c.objs("findings").flatMap { it.objs("findings") }.filter { it.str("state") == "open" }
                val needs = (c["needs"] as? List<*>)?.size ?: 0
                val manual = (c["manualSteps"] as? List<*>)?.size ?: 0
                WaitingChange(id, c.str("title") ?: id, c.str("state") ?: "", open.size, open.count { it.str("severity") == "blocking" }, needs, manual)
            }.filter { it.openFindings + it.needs + it.manualSteps > 0 }
        val knowledge = (other?.get("knowledgeToVerify") as? Number)?.toInt() ?: 0
        return WaitingView(questions, changes, knowledge)
    }

    /** The open questions `atticus questions list --state open --json` printed, with their choices. */
    fun questions(json: String): List<OpenQuestion> {
        val root = runCatching { Json.objectIn(json) }.getOrNull().obj() ?: return emptyList()
        return root.objs("questions").filter { (it.str("state") ?: "open") == "open" }.mapNotNull(::question)
    }

    internal fun question(q: Map<*, *>): OpenQuestion? {
        val id = q.str("id") ?: return null
        val options = q.objs("options").mapNotNull { o -> o.str("label")?.let { QuestionOption(it, o.str("means") ?: "") } }
        return OpenQuestion(id, q.str("repo") ?: "", q.str("question") ?: id, options, q.strs("evidence").orEmpty())
    }
}

/** A flow step that cites a line. */
data class CiteFlow(val repo: String, val flow: String, val name: String, val step: Int, val changes: List<String>)

/** A record that cites a line. */
data class CiteRecord(val kind: String, val id: String, val name: String?)

/** One cited line of a file, from `atticus cites --json`. */
data class CiteLine(val line: Int, val flows: List<CiteFlow>, val records: List<CiteRecord>) {
    /** The changes in flight on any flow through this line, once each. */
    val changes: List<String> get() = flows.flatMap { it.changes }.distinct()
}

object Cites {
    fun parse(json: String): List<CiteLine> {
        val root = runCatching { Json.objectIn(json) }.getOrNull().obj() ?: return emptyList()
        return root.objs("lines").mapNotNull { l ->
            val line = (l["line"] as? Number)?.toInt() ?: return@mapNotNull null
            val flows =
                l.objs("flows").mapNotNull { f ->
                    val id = f.str("flow") ?: return@mapNotNull null
                    CiteFlow(f.str("repo") ?: "", id, f.str("name") ?: id, (f["step"] as? Number)?.toInt() ?: 0, f.strs("changes").orEmpty())
                }
            val records = l.objs("records").mapNotNull { r -> r.str("id")?.let { CiteRecord(r.str("kind") ?: "", it, r.str("name")) } }
            CiteLine(line, flows, records)
        }
    }
}

/** WP6: the words and arguments of IntelliJ's own pieces, tested without the IDE. */
object Peer {
    fun changeLine(c: WaitingChange): String =
        listOfNotNull(
            if (c.openFindings > 0) "${plural(c.openFindings, "finding")} open${if (c.blocking > 0) " (${c.blocking} blocking)" else ""}" else null,
            if (c.needs > 0) plural(c.needs, "need") else null,
            if (c.manualSteps > 0) plural(c.manualSteps, "manual step") else null,
        ).joinToString(", ")

    private fun plural(n: Int, word: String) = "$n $word${if (n == 1) "" else "s"}"

    /** `atticus questions answer`: by option number (from 1) or in the person's own words; null when neither. */
    fun answerArgv(id: String, option: Int?, text: String?): List<String>? =
        when {
            option != null -> listOf("questions", "answer", id, "--option", option.toString())
            !text.isNullOrBlank() -> listOf("questions", "answer", id, "--text", text.trim())
            else -> null
        }

    /** What the gutter says about a cited line. */
    fun citeTip(l: CiteLine): String =
        (
            l.flows.map { "${it.name} (step ${it.step})" } +
                listOfNotNull(l.changes.takeIf { it.isNotEmpty() }?.let { "${plural(it.size, "change")} in flight: ${it.joinToString(", ")}" }) +
                l.records.map { "${it.kind} ${it.name ?: it.id}" }
        ).joinToString("; ")

    /** The archived changes `atticus change similar --json` found, best first. */
    fun pastChanges(json: String): List<PastChangeRow> =
        runCatching { Json.objectIn(json) }.getOrNull().obj()?.objs("changes").orEmpty().mapNotNull { c ->
            val id = c.str("id") ?: return@mapNotNull null
            PastChangeRow(id, c.str("title") ?: id, c.str("archived"))
        }

    /** The lines `atticus watch --json` says about each watched change. */
    fun watchLines(json: String): List<String> = runCatching { Json.objectIn(json) }.getOrNull().obj()?.strs("lines").orEmpty()

    /** The status bar, in the Next step's words (VS Code's statusText). */
    fun statusText(questions: Int?, next: NextStep?, watching: Int): String {
        val parts = mutableListOf<String>()
        if (questions != null) parts += plural(questions, "question")
        if (next != null) {
            val t = if (next.person) "a person's step" else Words.stepTitle(next)
            parts += "next: ${if (t.length > 70) "${t.take(67).trimEnd()}…" else t}"
        }
        if (watching > 0) parts += "watching $watching"
        return "Atticus${if (parts.isNotEmpty()) ": ${parts.joinToString(" · ")}" else ""}"
    }

    /** A metarepo's folder name: null when it will do, else what it must be. */
    fun checkName(name: String): String? = if (Regex("^[a-z0-9][a-z0-9._-]*$").matches(name.trim())) null else Copy.NAME_RULE

    fun checkPlatform(platform: String): String? = if (Regex("^[a-z][a-z0-9-]*$").matches(platform.trim())) null else Copy.PLATFORM_RULE

    /** The Copilot prompt file a slash command reads (atticus assistant-files writes it). */
    fun promptFileFor(slash: String): String? = Regex("^/(atticus-[a-z0-9-]+)").find(slash.trim())?.let { ".github/prompts/${it.groupValues[1]}.prompt.md" }

    fun hasPromptFile(metarepo: Path, slash: String): Boolean = promptFileFor(slash)?.let { Files.isRegularFile(metarepo.resolve(it)) } ?: false
}
