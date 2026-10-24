package com.maycombhq.atticus.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files

/** WP6: what IntelliJ reads to be a peer of VS Code: waiting, questions, cites, watch, the status bar. */
class PeerTest {
    private val waiting = """
        {
          "by": "change",
          "changes": [
            {
              "change": "add-transfer-limit", "title": "Add a transfer limit", "state": "define",
              "needs": [{"item": "firewall"}],
              "findings": [
                {"gate": "define", "findings": [
                  {"id": "a", "severity": "blocking", "state": "open"},
                  {"id": "b", "severity": "gap", "state": "open"},
                  {"id": "c", "severity": "risk", "state": "applied"}
                ]}
              ],
              "manualSteps": []
            },
            {"change": "quiet-change", "title": "Nothing waits", "state": "plan", "needs": [], "findings": [], "manualSteps": []}
          ],
          "other": {
            "questions": [
              {"id": "q-1", "repo": "forge-web", "question": "Which repo answers on pay.example?",
               "options": [{"label": "forge-web", "means": "it serves HTTP"}, {"label": "None", "means": "outside the estate"}],
               "evidence": ["src/a.ts:12"]}
            ],
            "manualSteps": [],
            "knowledgeToVerify": 5
          },
          "counts": {"questions": 1, "needs": 1, "manualSteps": 0, "findings": 2, "knowledgeToVerify": 5}
        }
    """.trimIndent()

    @Test
    fun `reads what waits, the questions with their options, each change with something open, and knowledge to verify`() {
        val w = Waiting.parse(waiting)!!
        assertEquals(1, w.questions.size)
        val q = w.questions[0]
        assertEquals("q-1", q.id)
        assertEquals(listOf("forge-web", "None"), q.options.map { it.label })
        assertEquals("outside the estate", q.options[1].means)
        assertEquals(listOf("src/a.ts:12"), q.evidence)
        assertEquals(listOf("add-transfer-limit"), w.changes.map { it.id })
        val c = w.changes[0]
        assertEquals(2, c.openFindings)
        assertEquals(1, c.blocking)
        assertEquals(1, c.needs)
        assertEquals("2 findings open (1 blocking), 1 need", Peer.changeLine(c))
        assertEquals(5, w.knowledgeToVerify)
        assertNull(Waiting.parse("not json"))
    }

    @Test
    fun `reads the open questions with their choices, leaving answered ones out`() {
        val json = """{"questions": [
            {"id": "q-1", "repo": "r", "question": "Which?", "state": "open", "options": [{"label": "A", "means": "a"}]},
            {"id": "q-2", "repo": "r", "question": "Done?", "state": "answered", "options": []}
        ]}"""
        assertEquals(listOf("q-1"), Waiting.questions(json).map { it.id })
        assertEquals("a", Waiting.questions(json)[0].options[0].means)
    }

    @Test
    fun `answers a question by option number or in the person's own words`() {
        assertEquals(listOf("questions", "answer", "q-1", "--option", "2"), Peer.answerArgv("q-1", 2, null))
        assertEquals(listOf("questions", "answer", "q-1", "--text", "It is forge-pay"), Peer.answerArgv("q-1", null, " It is forge-pay "))
        assertNull(Peer.answerArgv("q-1", null, "  "))
    }

    @Test
    fun `reads the lines a file is cited on, with the flows, the changes in flight and the records`() {
        val json = """
            {"repo": "forge-customers", "path": "src/C.java", "lines": [
              {"line": 10, "flows": [{"repo": "forge-customers", "flow": "forge-customers.create-customer", "name": "A client creates a customer", "step": 0, "kind": "endpoint", "changes": ["add-vip"]}],
               "records": [{"kind": "Endpoint", "id": "forge-customers.post-customer", "source": "code"}]},
              {"line": 12, "flows": [], "records": [{"kind": "Table", "id": "customers-db.customer", "name": "customer", "source": "code"}]}
            ]}
        """.trimIndent()
        val lines = Cites.parse(json)
        assertEquals(listOf(10, 12), lines.map { it.line })
        assertEquals(listOf("forge-customers.create-customer"), lines[0].flows.map { it.flow })
        assertEquals(listOf("add-vip"), lines[0].changes)
        assertEquals("A client creates a customer (step 0); 1 change in flight: add-vip; Endpoint forge-customers.post-customer", Peer.citeTip(lines[0]))
        assertEquals("Table customer", Peer.citeTip(lines[1]))
        assertTrue(Cites.parse("{}").isEmpty())
    }

    @Test
    fun `reads the earlier changes like a new one, and opens a change at a glance`() {
        val json = """{"how": "words", "changes": [{"id": "2026-05-12-raise-transfer-limit", "change": "raise-transfer-limit", "title": "Raise the limit", "archived": "2026-05-12", "summary": "", "file": "x", "score": 1}]}"""
        assertEquals(listOf(PastChangeRow("2026-05-12-raise-transfer-limit", "Raise the limit", "2026-05-12")), Peer.pastChanges(json))
        assertTrue(Peer.pastChanges("No archived change").isEmpty())
        assertEquals("#/cockpit?change=add%20limit", Commands.cockpitHash("add limit"))
        assertEquals("#/flows?repo=forge-web&flow=forge-web.save&step=2", Commands.flowHash("forge-web", "forge-web.save", 2))
        assertEquals("#/impact?q=forge-web.save", Commands.impactHash("forge-web.save"))
    }

    @Test
    fun `reads what the person watches`() {
        assertEquals(listOf("add-transfer-limit: in define. Next: raise the hand-off."), Peer.watchLines("""{"watching": ["add-transfer-limit"], "lines": ["add-transfer-limit: in define. Next: raise the hand-off."]}"""))
        assertTrue(Peer.watchLines("").isEmpty())
    }

    @Test
    fun `the status bar says the questions, the next step and how many changes are watched, as VS Code does`() {
        val next = NextStep(step = "feature", command = "atticus change feature add-limit", why = "", change = "add-limit")
        assertEquals("Atticus: 1 question · next: Place add-limit on the flows and features · watching 2", Peer.statusText(1, next, 2))
        assertEquals("Atticus: 0 questions", Peer.statusText(0, null, 0))
        assertEquals("Atticus", Peer.statusText(null, null, 0))
        assertEquals("Atticus: 3 questions · next: a person's step", Peer.statusText(3, next.copy(person = true), 0))
    }

    @Test
    fun `a metarepo's name and platform are checked before init runs`() {
        assertNull(Peer.checkName("payments-meta"))
        assertEquals(Copy.NAME_RULE, Peer.checkName("Payments Meta"))
        assertEquals(Copy.NAME_RULE, Peer.checkName(""))
        assertNull(Peer.checkPlatform("payments"))
        assertEquals(Copy.PLATFORM_RULE, Peer.checkPlatform("pay ments"))
    }

    @Test
    fun `an AI step's slash command is offered only when the metarepo has its prompt file`() {
        val root = Files.createTempDirectory("atticus-peer-")
        assertEquals(".github/prompts/atticus-feature.prompt.md", Peer.promptFileFor("/atticus-feature add-limit"))
        assertNull(Peer.promptFileFor("not a slash command"))
        assertFalse(Peer.hasPromptFile(root, "/atticus-feature add-limit"))
        Files.createDirectories(root.resolve(".github/prompts"))
        Files.writeString(root.resolve(".github/prompts/atticus-feature.prompt.md"), "x")
        assertTrue(Peer.hasPromptFile(root, "/atticus-feature add-limit"))
    }
}
