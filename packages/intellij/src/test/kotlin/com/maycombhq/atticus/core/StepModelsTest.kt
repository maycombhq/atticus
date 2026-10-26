package com.maycombhq.atticus.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** ADR 0121 addendum: the model each kind of step expects, from the settings and runtime.yaml. */
class StepModelsTest {
    @Test
    fun `knows each AI step command's kind, as the command line does`() {
        assertEquals(StepClass.READ, StepModels.classOf(listOf("map", "forge-ledger")))
        assertEquals(StepClass.READ, StepModels.classOf(listOf("scan", "verify", "forge-ledger", "--handoff")))
        assertEquals(StepClass.DRAFT, StepModels.classOf(listOf("change", "architecture", "add-transfer-limit")))
        assertEquals(StepClass.DRAFT, StepModels.classOf(listOf("task", "add-transfer-limit", "T1")))
        assertNull(StepModels.classOf(listOf("task", "context", "add-transfer-limit", "T1")))
        assertEquals(StepClass.CRITIC, StepModels.classOf(listOf("critic", "add-transfer-limit")))
        assertEquals(StepClass.KNOWLEDGE, StepModels.classOf(listOf("change", "needs", "add-transfer-limit")))
        assertNull(StepModels.classOf(listOf("catalog", "list")))
        assertEquals(StepClass.QUICK, StepClass.of("quick"))
        assertNull(StepClass.of("huge"))
    }

    @Test
    fun `takes the person's setting, then runtime yaml's, and says neither when none is named`() {
        val org = mapOf("draft" to "copilot/claude-opus-4.5", "critic" to "copilot/claude-sonnet-4.5")
        val mine = mapOf(StepClass.CRITIC to "copilot/gpt-5-mini", StepClass.QUICK to "atticus")
        assertEquals(
            ExpectedModel(StepClass.CRITIC, "copilot/gpt-5-mini", ModelFrom.SETTING),
            StepModels.expected(StepClass.CRITIC, mine, org),
        )
        assertEquals(
            ExpectedModel(StepClass.DRAFT, "copilot/claude-opus-4.5", ModelFrom.RUNTIME_YAML),
            StepModels.expected(StepClass.DRAFT, mine, org),
        )
        // `atticus` in a setting means runtime.yaml's; with nothing there, Copilot's own choice.
        assertNull(StepModels.expected(StepClass.QUICK, mine, org))
        assertNull(StepModels.expected(StepClass.READ, emptyMap(), emptyMap()))
    }

    @Test
    fun `passes the person's settings to the command line, one variable per kind`() {
        val env = StepModels.env(mapOf(StepClass.READ to " claude-opus-5-5 ", StepClass.QUICK to "atticus", StepClass.DRAFT to ""))
        assertEquals(mapOf("ATTICUS_MODEL_READ" to "claude-opus-5-5"), env)
        assertEquals("ATTICUS_MODEL_KNOWLEDGE", StepClass.KNOWLEDGE.env)
    }

    @Test
    fun `names the expected model in the hand-off text, for Copilot's own picker`() {
        val text = Copy.expectsModel(ExpectedModel(StepClass.DRAFT, "copilot/claude-opus-4.5", ModelFrom.RUNTIME_YAML))
        assertEquals(
            "This is a draft step: it expects copilot/claude-opus-4.5 (runtime.yaml models.draft). Pick it in Copilot's model picker before you send the prompt.",
            text,
        )
        assertTrue(Copy.expectsModel(ExpectedModel(StepClass.READ, "x", ModelFrom.SETTING)).contains("(your setting)"))
        for (c in StepClass.entries) assertTrue(Copy.settingsModelHint(c).isNotBlank())
        assertEquals("Knowledge steps:", Copy.settingsModel(StepClass.KNOWLEDGE))
    }

    @Test
    fun `reads each step's kind and runtime yaml's models from atticus next`() {
        val v =
            Next.parse(
                """{"steps": [{"step": "feature", "command": "atticus change feature add-transfer-limit", "why": "x", "stepClass": "draft"}],
                   "orgModels": {"draft": "copilot/claude-opus-4.5", "quick": "copilot/claude-haiku-4.5"}}""",
            )!!
        assertEquals("draft", v.steps[0].stepClass)
        assertEquals(mapOf("draft" to "copilot/claude-opus-4.5", "quick" to "copilot/claude-haiku-4.5"), v.orgModels)
        assertEquals(emptyMap<String, String>(), Next.parse("{\"steps\": []}")!!.orgModels)
    }
}
