package com.maycombhq.atticus.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

/**
 * ADR 0121 addendum 2: the AI-step path through GitHub Copilot in IntelliJ. What goes on the
 * clipboard, what the notice says, and the one limit said plainly.
 */
class HandoffTest {
    @TempDir
    lateinit var dir: Path

    private fun promptFile(slash: String) {
        val p = dir.resolve(Peer.promptFileFor(slash)!!)
        Files.createDirectories(p.parent)
        Files.writeString(p, "# The step's prompt\n")
    }

    @Test
    fun `the slash command goes on the clipboard once its prompt file is written`() {
        promptFile("/atticus-spec")
        assertEquals(ToPaste.Slash("/atticus-spec forge-ledger"), Handoff.toPaste(dir, "/atticus-spec forge-ledger", null))
    }

    @Test
    fun `with no prompt file the prompt the hand-off wrote goes on the clipboard`() {
        val rel = "changes/add-transfer-limit/.runs/spec.prompt.md"
        val p = dir.resolve(rel)
        Files.createDirectories(p.parent)
        Files.writeString(p, "Read forge-ledger and write its spec.\n")
        val paste = Handoff.toPaste(dir, "/atticus-spec forge-ledger", rel)
        assertEquals(ToPaste.Prompt(rel, "Read forge-ledger and write its spec.\n"), paste)
    }

    @Test
    fun `with neither it says to write the prompt files`() {
        assertEquals(ToPaste.Nothing("/atticus-spec forge-ledger"), Handoff.toPaste(dir, "/atticus-spec forge-ledger", null))
        assertEquals(ToPaste.Nothing(null), Handoff.toPaste(null, null, null))
    }

    @Test
    fun `the notice names the model the step expects and the limit`() {
        promptFile("/atticus-critic")
        val paste = Handoff.toPaste(dir, "/atticus-critic add-transfer-limit", null)
        val expects = ExpectedModel(StepClass.CRITIC, "copilot/claude-opus-4.5", ModelFrom.SETTING)
        val lines = Handoff.notice(paste, expects, "in Copilot Chat")
        assertTrue(lines[0].contains("/atticus-critic add-transfer-limit"), lines[0])
        assertTrue(lines[1].contains("copilot/claude-opus-4.5"), lines[1])
        assertTrue(lines[1].contains("critic"), lines[1])
        assertTrue(lines.any { it == Copy.COPILOT_NO_API }, "the limit is said")
        assertEquals(Copy.CLI_CHECKS_THE_ANSWER, lines.last())
    }

    @Test
    fun `the notice leaves the model line out when nothing names one`() {
        promptFile("/atticus-survey")
        val lines = Handoff.notice(Handoff.toPaste(dir, "/atticus-survey forge-ledger", null), null, null)
        assertEquals(listOf(Copy.pasteSlash("/atticus-survey forge-ledger"), Copy.COPILOT_NO_API, Copy.CLI_CHECKS_THE_ANSWER), lines)
    }

    @Test
    fun `where the chat can be opened from here the notice says so instead`() {
        promptFile("/atticus-survey")
        val lines = Handoff.notice(Handoff.toPaste(dir, "/atticus-survey forge-ledger", null), null, null, copilotApi = true)
        assertTrue(lines.contains(Copy.COPILOT_API), "it says the chat was opened")
        assertEquals(false, lines.contains(Copy.COPILOT_NO_API), "and not that nothing is reachable")
    }

    @Test
    fun `Claude Code in a terminal runs the same slash command`() {
        assertEquals(listOf("claude", "/atticus-stories add-transfer-limit"), Handoff.claudeCodeArgv("/atticus-stories add-transfer-limit"))
    }

    @Test
    fun `model mode adds Atticus's own model to the ways a step can run`() {
        assertEquals(
            listOf(RunStepHere.COPILOT, RunStepHere.CLAUDE_CODE, RunStepHere.HANDOFF),
            Handoff.ways(modelMode = false),
        )
        assertEquals(
            listOf(RunStepHere.COPILOT, RunStepHere.CLAUDE_CODE, RunStepHere.MODEL, RunStepHere.HANDOFF),
            Handoff.ways(modelMode = true),
        )
    }
}
