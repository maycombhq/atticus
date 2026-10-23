package com.maycombhq.atticus.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

/** Run a Command picks what only the metarepo knows, as the VS Code extension does, from the command line's JSON and the metarepo's files. */
class ListsTest {
    @Test
    fun `knows which arguments are the metarepo's own ids`() {
        assertEquals("knowledge-item", Lists.kindFor("knowledge verify", "item", "text"))
        assertEquals("need", Lists.kindFor("needs done", "item", "text"))
        assertEquals("feature", Lists.kindFor("feature show", "id", "text"))
        assertEquals("todo", Lists.kindFor("todo done", "step", "text"))
        assertEquals("triage", Lists.kindFor("triage decide", "item", "text"))
        assertEquals("term", Lists.kindFor("glossary link", "term", "text"))
        assertEquals("dialect-proposal", Lists.kindFor("onboard accept", "name", "text"))
        assertEquals("framework-proposal", Lists.kindFor("onboard accept framework", "name", "text"))
        assertEquals("story", Lists.kindFor("tests generate", "story", "text"))
        assertEquals("flow", Lists.kindFor("spec show", "flow", "flow"))
        assertEquals("system", Lists.kindFor("guide", "system", "system"))
        assertEquals("record", Lists.kindFor("impact", "id", "record"))
        assertEquals("finding", Lists.kindFor("critic accept", "finding", "finding"))
        // A new term is the person's own words.
        assertNull(Lists.kindFor("glossary define", "term", "text"))
    }

    @Test
    fun `reads each list the command line prints`() {
        assertEquals(
            listOf(Pick("certificate-renewal", "Renewing a TLS certificate", "request · not reviewed")),
            Lists.knowledgeItems("""[{"kind":"ProcessDefinition","id":"certificate-renewal","title":"Renewing a TLS certificate","knowledgeKind":"request"}]"""),
        )
        assertEquals(
            listOf(Pick("firewall-rule-request", "Network firewall rule", "open · for task:1.3")),
            Lists.needs("""[{"item":"firewall-rule-request","title":"Network firewall rule","status":"open","for":"task:1.3"}]"""),
        )
        assertEquals(listOf(Pick("feature.transfers", "Transfers", "feature.transfers")), Lists.features("""{"features":[{"id":"feature.transfers","name":"Transfers"}]}"""))
        assertEquals(
            listOf(Pick("add-transfer-limit/raise-topic", "Raise the topic request", "add-transfer-limit · open")),
            Lists.todos("""[{"id":"raise-topic","change":"add-transfer-limit","title":"Raise the topic request","state":"open"}]"""),
        )
        assertEquals(listOf(Pick("e5", "Drawn as a call, reads the database", "conflict")), Lists.triage("""{"items":[{"id":"e5","kind":"conflict","summary":"Drawn as a call, reads the database"}]}"""))
        assertEquals(listOf(Pick("Account", "Account", "")), Lists.terms("""{"terms":[{"id":"term.account","term":"Account"}]}"""))
        assertEquals(listOf(Pick("f1", "No retry on the vendor call", "major")), Lists.findings("""[{"id":"f1","summary":"No retry on the vendor call","severity":"major","state":"open"}]"""))
        assertEquals(emptyList<Pick>(), Lists.features("not JSON"))
    }

    @Test
    fun `reads records, flows, proposals and stories from the metarepo's files`(@TempDir root: Path) {
        fun write(rel: String, text: String) = root.resolve(rel).also { Files.createDirectories(it.parent) }.let { Files.writeString(it, text) }
        write("catalog/generated/system/ledger.yaml", "kind: System\nid: ledger\nname: Ledger Platform\n")
        write("catalog/generated/endpoint/ledger-api.get-balance.yaml", "kind: Endpoint\nid: ledger-api.get-balance\n")
        write("specs/forge-ledger/forge-ledger.post-transfer.yaml", "id: forge-ledger.post-transfer\nname: Post a transfer\n")
        write("proposals/dialects/anvil.yaml", "x: 1\n")
        write("proposals/frameworks/anvil-web.yaml", "x: 1\n")
        write("openspec/changes/add-transfer-limit/stories/s1-refuse-over-limit.md", "# Refuse transfers over the daily limit\n\nAs a customer…\n")
        assertEquals(listOf(Pick("ledger", "Ledger Platform", "System")), Lists.records(root, "System"))
        assertEquals(
            listOf(Pick("ledger-api.get-balance", "ledger-api.get-balance", "Endpoint"), Pick("ledger", "Ledger Platform", "System")),
            Lists.records(root, null),
        )
        assertEquals(listOf(Pick("forge-ledger.post-transfer", "Post a transfer", "forge-ledger")), Lists.flows(root))
        assertEquals(listOf(Pick("anvil", "anvil", "")), Lists.proposals(root, "dialects"))
        assertEquals(listOf(Pick("s1-refuse-over-limit", "Refuse transfers over the daily limit", "s1-refuse-over-limit")), Lists.stories(root, "add-transfer-limit"))
        assertEquals(emptyList<Pick>(), Lists.stories(root, "no-such-change"))
    }

    @Test
    fun `reads a change's tasks from its tasks md, each under its repo (ADR 0113)`(@TempDir root: Path) {
        val f = root.resolve("openspec/changes/return-order-time/tasks.md")
        Files.createDirectories(f.parent)
        Files.writeString(
            f,
            listOf(
                "<!-- Generated -->",
                "# Tasks",
                "",
                "## forge-orders",
                "",
                "- [ ] 1.1 Change the respond step (story s1-place-order)",
                "- [x] 1.2 Add a test (story s1-place-order)",
                "",
            ).joinToString("\n"),
        )
        assertEquals(
            listOf(Pick("1.1", "Change the respond step", "forge-orders"), Pick("1.2", "Add a test", "forge-orders · done")),
            Lists.tasks(root, "return-order-time"),
        )
        assertEquals(emptyList<Pick>(), Lists.tasks(root, "no-such-change"))
    }
}
