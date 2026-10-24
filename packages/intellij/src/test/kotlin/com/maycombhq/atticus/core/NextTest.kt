package com.maycombhq.atticus.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/** `atticus next --json`, and what the plugin does for the step it names (ADR 0099). */
class NextTest {
    private val json = """
        {
          "next": {
            "step": "accept",
            "command": "atticus scan verify forge-web --accept",
            "where": "metarepo",
            "why": "forge-web's scan proposal waits for a person. Review it, then accept.",
            "person": true,
            "repo": "forge-web"
          },
          "steps": [
            {"step": "accept", "command": "atticus scan verify forge-web --accept", "why": "x", "person": true, "repo": "forge-web"},
            {"step": "spec", "command": "atticus spec draft forge-web", "slash": "/atticus-spec forge-web", "why": "No spec yet.", "repo": "forge-web"}
          ]
        }
    """.trimIndent()

    @Test
    fun `reads the next step and the steps after it`() {
        val v = Next.parse(json)!!
        assertEquals("accept", v.next?.step)
        assertEquals("forge-web", v.next?.repo)
        assertEquals(true, v.next?.person)
        assertEquals(2, v.steps.size)
        assertEquals("/atticus-spec forge-web", v.steps[1].slash)
        assertEquals(NextView(null, emptyList()), Next.parse("{\"steps\": []}"))
        assertNull(Next.parse("Not a metarepo"))
    }

    @Test
    fun `reads what runs a step, and whether it can run on the configured model (ADR 0121)`() {
        val v = Next.parse("""{"steps": [], "runs": "Hand-off to GitHub Copilot · model mode allowed: vertex", "modelMode": true}""")!!
        assertEquals("Hand-off to GitHub Copilot · model mode allowed: vertex", v.runs)
        assertEquals(true, v.modelMode)
        assertEquals(false, Next.parse("{\"steps\": []}")!!.modelMode)
        assertEquals(listOf("change", "feature", "add-limit", "--mode", "model"), Commands.withModel(listOf("change", "feature", "add-limit")))
        assertEquals(listOf("change", "feature", "add-limit", "--mode", "model"), Commands.withModel(listOf("change", "feature", "add-limit", "--handoff", "--mode", "hand-off")))
    }

    @Test
    fun `the words of a printed command, quotes kept together`() {
        assertEquals(listOf("change", "new", "Tag notes", "--type", "feature"), Next.argsOf("atticus change new \"Tag notes\" --type feature"))
    }

    private fun step(step: String, command: String, slash: String? = null, person: Boolean = false, repo: String? = null) =
        NextStep(step = step, command = command, why = "Why.", slash = slash, person = person, repo = repo)

    @Test
    fun `an AI step is run in Copilot Chat with its slash command`() {
        assertEquals(
            NextAction.Ai(listOf("spec", "draft", "forge-web"), "/atticus-spec forge-web"),
            Next.actionFor(step("spec", "atticus spec draft forge-web", slash = "/atticus-spec forge-web", repo = "forge-web")),
        )
        // Without the slash from atticus next, the plugin's own map gives it.
        assertEquals(
            NextAction.Ai(listOf("plan", "stories", "add-note-tags"), "/atticus-stories add-note-tags"),
            Next.actionFor(step("stories", "atticus plan stories add-note-tags")),
        )
        // A change's needs: an AI step, never run here as a plain command.
        assertEquals(
            NextAction.Ai(listOf("change", "needs", "add-note-tags"), "/atticus-needs add-note-tags"),
            Next.actionFor(step("needs", "atticus change needs add-note-tags", slash = "/atticus-needs add-note-tags")),
        )
        // A step atticus next gives a slash command for is an AI step, whatever the plugin knows.
        assertEquals(
            NextAction.Ai(listOf("frameworks", "draft", "anvil"), "/atticus-frameworks anvil"),
            Next.actionFor(step("frameworks", "atticus frameworks draft anvil", slash = "/atticus-frameworks anvil")),
        )
    }

    @Test
    fun `answering is its own action, a person's step is shown, the rest runs`() {
        assertEquals(NextAction.Answer("/atticus-answer"), Next.actionFor(step("answer", "atticus questions list --state open", slash = "/atticus-answer", person = true)))
        assertEquals(NextAction.Person("atticus scan verify forge-web --accept"), Next.actionFor(step("accept", "atticus scan verify forge-web --accept", person = true)))
        assertEquals(NextAction.Person("atticus change new \"<title>\" --type <type>"), Next.actionFor(step("new-change", "atticus change new \"<title>\" --type <type>")))
        assertEquals(NextAction.Run(listOf("scan", "forge-web")), Next.actionFor(step("scan", "atticus scan forge-web")))
    }
}
