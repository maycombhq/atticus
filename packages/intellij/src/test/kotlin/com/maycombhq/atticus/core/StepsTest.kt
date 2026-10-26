package com.maycombhq.atticus.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/**
 * ADR 0105 addendum 2: each native action's command, the slash command an AI step goes to Copilot
 * Chat by, and the class of step it runs as, worked out without the IDE.
 */
class StepsTest {
    private fun step(actionId: String) = Steps.of(actionId) ?: error("no step $actionId")

    @Test
    fun `an AI step on a repo takes the repo and knows its slash command`() {
        val s = step("Atticus.DraftSpec")
        assertEquals(StepTarget.REPO, s.target)
        assertEquals(listOf("spec", "draft", "forge-ledger"), s.argv("forge-ledger"))
        assertEquals("/atticus-spec forge-ledger", s.slash("forge-ledger"))
        assertEquals(StepClass.DRAFT, Steps.classOf(s))
    }

    @Test
    fun `the critic is a critic step on a change`() {
        val s = step("Atticus.Critic")
        assertEquals(StepTarget.CHANGE, s.target)
        assertEquals("/atticus-critic add-transfer-limit", s.slash("add-transfer-limit"))
        assertEquals(StepClass.CRITIC, Steps.classOf(s))
    }

    @Test
    fun `reading a repo is a read step`() {
        val s = step("Atticus.ReadRepo")
        assertEquals(listOf("map", "forge-ledger"), s.argv("forge-ledger"))
        assertEquals(StepClass.READ, Steps.classOf(s))
    }

    @Test
    fun `a command Atticus runs itself has no slash command`() {
        val s = step("Atticus.VerifyFacts")
        assertEquals(false, s.ai)
        assertNull(s.slash("forge-ledger"))
        assertEquals(listOf("verify", "forge-ledger"), s.argv("forge-ledger"))
    }

    @Test
    fun `a step that takes nothing leaves the target off`() {
        val s = step("Atticus.ScanAll")
        assertEquals(StepTarget.NONE, s.target)
        assertEquals(listOf("scan"), s.argv(null))
        assertEquals(listOf("scan"), s.argv("  "))
    }

    @Test
    fun `saying what a repo is runs repo describe`() {
        assertEquals(listOf("repo", "describe", "forge-ledger"), step("Atticus.DescribeRepo").argv("forge-ledger"))
    }

    @Test
    fun `every AI step has a slash command for its target kind`() {
        for (s in Steps.AI) {
            val target = if (s.target == StepTarget.NONE) null else "forge-ledger"
            assertEquals(true, s.slash(target) != null, "${s.actionId} has no slash command")
        }
    }

    @Test
    fun `every step names an action and a command`() {
        for (s in Steps.ALL) {
            assertEquals(true, s.actionId.startsWith("Atticus."), s.actionId)
            assertEquals(true, s.words.isNotEmpty(), s.actionId)
        }
    }
}
