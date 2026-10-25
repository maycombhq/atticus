package com.maycombhq.atticus.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** ADR 0098 and 0099: plain words first; the command is beside them, not instead. */
class WordsTest {
    private fun s(step: String, repo: String? = null, change: String? = null) =
        Words.stepTitle(NextStep(step = step, command = "atticus x", why = "Because. Then more.", repo = repo, change = change))

    @Test
    fun `the next step says what it does, naming the repo or change`() {
        assertEquals("Review and accept nadiengine's scan proposal", s("accept", repo = "nadiengine"))
        assertEquals("Draft forge-web's scan settings with Copilot", s("survey", repo = "forge-web"))
        assertEquals("Draft forge-web's spec with Copilot", s("spec", repo = "forge-web"))
        assertEquals("Place add-note-tags on the flows and features", s("feature", change = "add-note-tags"))
        assertEquals("Answer the open questions", s("answer"))
        assertEquals("Start a change", s("new-change"))
        assertEquals("Scan the repos", s("scan"))
        assertEquals("Scan forge-api", s("scan", repo = "forge-api"))
        assertEquals("Check the repo's spec", s("spec-check"))
        // Atticus 2's first step (ADR 0124): run in the IDE, its title was the why sentence, shown twice.
        assertEquals("Read forge-portal-ui's code into facts with Copilot", s("map", repo = "forge-portal-ui"))
    }

    @Test
    fun `every step VS Code has words for has the same words here`() {
        val words = java.nio.file.Files.readString(java.nio.file.Path.of("").toAbsolutePath().parent.resolve("vscode/src/words.ts"))
        val table = words.substringAfter("const STEP_TITLES").substringBefore("\n};")
        val steps = Regex("""^\s+"?([a-z-]+)"?: \(""", RegexOption.MULTILINE).findAll(table).map { it.groupValues[1] }.toList()
        assertEquals(true, steps.size > 20, "read VS Code's step titles")
        // "Because" is the first sentence of why: the words for a step this doesn't know.
        assertEquals(emptyList<String>(), steps.filter { s(it) == "Because" }, "steps VS Code names and IntelliJ doesn't")
        assertEquals("Plan add-limit, a small change, in one step", s("small", change = "add-limit"))
        assertEquals("Find what add-limit needs from the organisation", s("needs", change = "add-limit"))
        assertEquals("Check the knowledge items your changes use", s("verify-knowledge"))
    }

    @Test
    fun `a step it doesn't know is the first sentence of why`() {
        assertEquals(
            "Do the new thing",
            Words.stepTitle(NextStep(step = "brand-new", command = "atticus y", why = "Do the new thing. More.")),
        )
    }

    @Test
    fun `a command leads with what it does, from its summary`() {
        assertEquals(
            "Your assistant reads the repo and drafts its scan settings",
            Words.commandTitle(
                "Your assistant reads the repo and drafts its scan settings (folders to leave out, path prefixes, client base URLs); checked against the code [--attempts 3] [--force]",
            ),
        )
        assertEquals("Start a change from a template", Words.commandTitle("Start a change from a template: --type <type>"))
        assertEquals("Check record files", Words.commandTitle("Check record files: schema, location and canonical form"))
        assertEquals("Create a new metarepo named after the folder", Words.commandTitle("Create a new metarepo named after the folder [--from pack] [--owner who]"))
        assertEquals("", Words.commandTitle(""))
    }

    @Test
    fun `a very long title is cut at 90 characters`() {
        val t = Words.commandTitle("word ".repeat(40))
        assertEquals(88, t.length)
        assertEquals('…', t.last())
    }
}
