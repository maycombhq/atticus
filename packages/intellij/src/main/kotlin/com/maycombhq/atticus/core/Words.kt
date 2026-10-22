package com.maycombhq.atticus.core

/**
 * The plugin's words for what Atticus does (ADR 0098, 0099): plain words first, the command
 * beside them. The same titles as the VS Code extension's words.ts.
 */
object Words {
    private val STEP_TITLES: Map<String, (NextStep) -> String> =
        mapOf(
            "discover" to { _ -> "Add the repos to the manifest" },
            "sync" to { _ -> "Clone or update the repos" },
            "survey" to { s -> "Draft ${s.repo ?: "the repo"}'s scan settings with Copilot" },
            "scan" to { s -> if (s.repo != null) "Scan ${s.repo}" else "Scan the repos" },
            "verify" to { s -> "Check ${s.repo ?: "the repo"}'s scan against its code with Copilot" },
            "accept" to { s -> "Review and accept ${s.repo ?: "the repo"}'s scan proposal" },
            "spec" to { s -> "Draft ${s.repo ?: "the repo"}'s spec with Copilot" },
            "spec-check" to { s -> "Check ${s.repo ?: "the repo"}'s spec" },
            "answer" to { _ -> "Answer the open questions" },
            "sync-source" to { s -> "Sync the knowledge source ${s.source ?: ""}".trimEnd() },
            "knowledge" to { _ -> "Read the knowledge sources with Copilot" },
            "new-change" to { _ -> "Start a change" },
            "feature" to { s -> "Place ${s.change ?: "the change"} on the flows and features" },
            "architecture" to { s -> "Design ${s.change ?: "the change"}'s target flows" },
            "stories" to { s -> "Write ${s.change ?: "the change"}'s stories and tasks" },
            "tasks" to { s -> "Work through ${s.change ?: "the change"}'s tasks" },
            "task" to { s -> "Run a task of ${s.change ?: "the change"}" },
            "release" to { s -> "Plan ${s.change ?: "the change"}'s release" },
        )

    /** The first sentence, without its full stop. */
    fun firstSentence(t: String): String =
        t.split(Regex("(?<=[.!?])\\s"))[0].replace(Regex("[.!?]$"), "").trim()

    /** What the next step does, for a person: the command goes beside it. */
    fun stepTitle(s: NextStep): String = STEP_TITLES[s.step]?.invoke(s) ?: firstSentence(s.why)

    /** What a command does, from its summary: up to its first colon, semicolon or bracket. */
    fun commandTitle(summary: String): String {
        val cut = summary.split(Regex(":\\s|;\\s|\\s\\(|\\s\\["))[0].trim()
        return if (cut.length > 90) "${cut.take(87).trimEnd()}…" else cut
    }

    const val INSTALL_URL = "https://github.com/maycombhq/atticus/blob/main/docs/guide/install.md"
}
