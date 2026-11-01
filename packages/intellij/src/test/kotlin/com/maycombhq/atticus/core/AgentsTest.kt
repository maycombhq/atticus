package com.maycombhq.atticus.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path

/** VS Code's "Run the next step in Copilot's agent mode", here (ADR 0121 addendum, ADR 0159). */
class AgentsTest {
    private val vscode = Files.readString(Path.of("").toAbsolutePath().parent.resolve("vscode/src/copilot-agent.ts"))

    @Test
    fun `the agent table is VS Code's`() {
        val table = vscode.substringAfter("export const AGENT_BY_STEP").substringBefore("\n};")
        val rows =
            Regex("""^\s+(\w+): \{\s*agent: "([a-z-]+)",\s*stepClass: "(\w+)"(?:,\s*slash: "([a-z-]+)")?""", RegexOption.MULTILINE)
                .findAll(table)
                .associate { m -> m.groupValues[1] to StepAgent(m.groupValues[2], m.groupValues[3], m.groupValues[4].ifEmpty { null }) }
        assertTrue(rows.size > 10, "read VS Code's agents: $rows")
        assertEquals(rows, Agents.BY_STEP)
    }

    @Test
    fun `a next step's command names its step and target`() {
        assertEquals("map" to "forge-web", Agents.stepNameOf("atticus map forge-web"))
        assertEquals("task" to "add-limit", Agents.stepNameOf("atticus task run add-limit t1"))
        assertEquals("stories" to "add-limit", Agents.stepNameOf("atticus plan stories add-limit"))
        assertEquals("verify" to "forge-web", Agents.stepNameOf("atticus verify forge-web --write"))
        assertEquals(null, Agents.stepNameOf("atticus workspace sync"))
    }

    @Test
    fun `the hand-off names the agent, with the slash command or the step spelled out`() {
        val root = Files.createTempDirectory("atticus-agents")
        assertTrue(Agents.handoff(root, "atticus map forge-web") is AgentHandoff.Chat, "no agent file yet")
        assertTrue(Agents.handoff(root, "atticus scan survey forge-web") is AgentHandoff.Chat, "no agent covers survey")
        Files.createDirectories(root.resolve(".github/agents"))
        Files.writeString(root.resolve(".github/agents/atticus-repo-reader.agent.md"), "---\nname: atticus-repo-reader\n---\n")
        val spelled = Agents.handoff(root, "atticus map forge-web") as AgentHandoff.Agent
        assertEquals("atticus-repo-reader", spelled.agent)
        assertEquals("read", spelled.stepClass)
        assertTrue(spelled.isPrompt)
        assertTrue(spelled.query.startsWith("Take the Atticus step `atticus map forge-web` for forge-web in this workspace"), spelled.query)
        Files.createDirectories(root.resolve(".github/prompts"))
        Files.writeString(root.resolve(".github/prompts/atticus-map.prompt.md"), "---\n---\n")
        assertEquals(AgentHandoff.Agent("atticus-repo-reader", "read", "/atticus-map forge-web", isPrompt = false), Agents.handoff(root, "atticus map forge-web"))
    }

    @Test
    fun `the spelled-out prompt is VS Code's, word for word`() {
        val body = Agents.spelledOut(StepAgent("atticus-verifier", "read"), null, null)
        for (line in body.lines().filter { it.isNotBlank() }.drop(1)) assertTrue(vscode.contains(line), "VS Code says: $line")
    }
}
