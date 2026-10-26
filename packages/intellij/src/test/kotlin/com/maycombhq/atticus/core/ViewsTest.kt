package com.maycombhq.atticus.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

/**
 * ADR 0105 addendum 2: the rows of the tool window's tabs, read from what the command line prints
 * and from the metarepo's own files. The invented Forge ecosystem only (CLAUDE.md rule 3).
 */
class ViewsTest {
    @TempDir
    lateinit var dir: Path

    // ------------------------------------------------------------------ the tabs and the filter

    @Test
    fun `the tool window offers what the sidebar offers`() {
        assertEquals(
            listOf("Next", "Waiting on you", "Changes", "Repos", "Knowledge", "Model runs", "Prompt history", "App", "Output"),
            Tabs.entries.map { it.tabName },
        )
    }

    @Test
    fun `the filter matches every word, in any field, in any case`() {
        val fields = listOf("Let members pin a message", "add-pin-message", "forge-ledger")
        assertTrue(Filter.matches("", fields))
        assertTrue(Filter.matches("  ", fields))
        assertTrue(Filter.matches("FORGE pin", fields))
        assertEquals(false, Filter.matches("forge northwind", fields))
        assertEquals(listOf("forge", "pin"), Filter.words("  FORGE   pin "))
    }

    // ------------------------------------------------------------------ Repos (ADR 0128)

    private val manifest =
        """
        platform: forge
        repos:
          - id: forge-ledger
            url: https://example.invalid/forge/forge-ledger.git
            description:
              text: Keeps the ledger of every posting.
              trust: verified
              by: tomachan
          - id: forge-shop-bff
            url: https://example.invalid/forge/forge-shop-bff.git
            description:
              text: Serves the shop's web pages.
              trust: suggested
              by: repo-reader
          - id: forge-edge-gateway
            url: https://example.invalid/forge/forge-edge-gateway.git
        """.trimIndent()

    @Test
    fun `a repo's description is read, and a draft is marked`() {
        val rows = Repos.rowsOf(manifest.lines())
        assertEquals(listOf("forge-ledger", "forge-shop-bff", "forge-edge-gateway"), rows.map { it.id })
        assertEquals("Keeps the ledger of every posting.", rows[0].detail)
        assertEquals(false, rows[0].suggested)
        assertEquals("Serves the shop's web pages. — drafted by your assistant, unconfirmed", rows[1].detail)
        assertEquals(true, rows[1].suggested)
        assertNull(rows[2].description)
        assertEquals(Copy.REPO_NO_DESCRIPTION, rows[2].detail)
    }

    @Test
    fun `the manifests of every profile are read, each repo once`() {
        val p = dir.resolve("org-pack/profiles/forge")
        Files.createDirectories(p)
        Files.writeString(p.resolve("repos.manifest.yaml"), manifest)
        assertEquals(listOf("forge-ledger", "forge-shop-bff", "forge-edge-gateway"), Repos.rows(dir.resolve("org-pack")).map { it.id })
    }

    @Test
    fun `what repo describe says is folded in`() {
        val json =
            """
            { "missing": ["forge-edge-gateway"],
              "unconfirmed": [{ "id": "forge-shop-bff", "text": "Serves the shop's web pages." }] }
            """.trimIndent()
        val merged = Repos.merged(Repos.rowsOf(manifest.lines()), Repos.described(json))
        assertEquals(true, merged.first { it.id == "forge-shop-bff" }.suggested)
        assertNull(merged.first { it.id == "forge-edge-gateway" }.description)
        assertEquals(false, merged.first { it.id == "forge-ledger" }.suggested)
    }

    // ------------------------------------------------------------------ Knowledge sources

    @Test
    fun `the wikis of sources yaml are read, in a block or on one line`() {
        val yaml =
            """
            schemaVersion: 1
            wikis:
              - { id: forge-wiki, type: markdown-folder, location: ../../inputs/wiki, owner: team-platform }
              - id: forge-docs
                type: git
                location: https://example.invalid/forge/docs.git
            """.trimIndent()
        val rows = Sources.rowsOf(yaml.lines())
        assertEquals(listOf("forge-wiki", "forge-docs"), rows.map { it.id })
        assertEquals("markdown-folder · owned by team-platform", rows[0].detail)
        assertEquals("git", rows[1].detail)
    }

    @Test
    fun `no sources file is no sources`() {
        assertEquals(emptyList<SourceRow>(), Sources.rows(dir.resolve("org-pack")))
    }

    // ------------------------------------------------------------------ Changes

    @Test
    fun `a change shows its progress, its risk and the kinds of test it needs`() {
        val list =
            """
            [ { "id": "add-transfer-limit", "title": "Cap a member's daily transfers", "state": "architecture" } ]
            """.trimIndent()
        val row = Changes.rows(list).single()
        val status =
            """
            { "id": "add-transfer-limit", "state": "architecture",
              "progress": { "summary": "the stories are drafted, ahead of the architecture gate" },
              "risk": { "level": "high", "score": 7 },
              "tests": { "required": ["contract", "integration"], "added": [{ "kinds": ["privacy"], "factor": "personal data" }] } }
            """.trimIndent()
        val full = Changes.withStatus(row, status)
        assertEquals("the stories are drafted, ahead of the architecture gate", full.work)
        assertEquals("high", full.riskLevel)
        assertEquals(listOf("contract", "integration", "privacy"), full.testKinds)
        assertTrue(full.detail.contains("risk high (7)"), full.detail)
        assertTrue(full.detail.contains("tests: contract, integration, privacy"), full.detail)
    }

    @Test
    fun `an OpenSpec store's change is marked read-only with its tasks`() {
        val list =
            """
            [ { "id": "add-refund-window", "title": "Refunds for ten days", "store": "forge-specs",
                "readOnly": true, "tasks": { "done": 2, "total": 5 } } ]
            """.trimIndent()
        val row = Changes.rows(list).single()
        assertEquals("forge-specs", row.store)
        assertTrue(row.detail.contains("OpenSpec store forge-specs (read-only)"), row.detail)
        assertTrue(row.detail.contains("2/5 tasks"), row.detail)
    }

    @Test
    fun `the OpenSpec stores' own lines are kept as rows`() {
        val printed =
            """
            Checked org-pack/openspec.yaml.
            OpenSpec store forge-specs (read-only, beta): 1 open change, 2 specs (orders, refunds)
            """.trimIndent()
        assertEquals(1, Changes.storeLines(printed).size)
        assertTrue(Changes.storeLines(printed).single().startsWith("OpenSpec store forge-specs"))
    }

    // ------------------------------------------------------------------ a task's knowledge

    @Test
    fun `a task's knowledge is ranked, with its also-on pages and the conflict question`() {
        val json =
            """
            { "task": { "id": "1.2" },
              "knowledge": [
                { "id": "k-retry", "kind": "Pattern", "knowledgeKind": "pattern",
                  "title": "Retry a posting three times", "why": "the task posts to forge-ledger",
                  "page": { "source": "forge-wiki", "page": "payments/retries", "section": "Postings" },
                  "alsoOn": [ { "source": "forge-wiki", "page": "runbooks/postings", "section": "Retries" } ],
                  "conflicts": [ { "question": { "text": "Two pages disagree on the retry count: which holds?" } } ],
                  "verified": true, "score": 9.5 },
                { "id": "k-limits", "kind": "Decision", "knowledgeKind": "decision",
                  "title": "Daily limits are set per member", "why": "the task reads the limit",
                  "page": { "source": "forge-docs", "page": "decisions/limits", "section": "Scope" },
                  "alsoOn": [], "conflicts": [], "verified": false, "score": 4.0 } ] }
            """.trimIndent()
        val rows = TaskKnowledge.rows(json)
        assertEquals(listOf("k-retry", "k-limits"), rows.map { it.id })
        assertEquals("forge-wiki/payments/retries#Postings", rows[0].page)
        assertEquals(listOf("forge-wiki/runbooks/postings#Retries"), rows[0].alsoOn)
        assertEquals("Two pages disagree on the retry count: which holds?", rows[0].conflictQuestion)
        assertTrue(rows[0].detail.contains("also on 1 other page"), rows[0].detail)
        assertTrue(rows[0].detail.contains("verified"), rows[0].detail)
        assertTrue(rows[1].detail.contains("not verified"), rows[1].detail)
        assertNull(rows[1].conflictQuestion)
    }

    // ------------------------------------------------------------------ a call's path through gateways

    @Test
    fun `a call through two gateways keeps each hop's auth and scopes`() {
        val json =
            """
            { "joins": [
                { "call": { "repo": "forge-orders", "fact": "call.post.charges", "component": "orders-api", "at": "src/Pay.java:31" },
                  "entry": { "repo": "northwind-pay-api", "fact": "entry.post.v2-charges", "component": "pay-api", "at": "routes.ts:12" },
                  "method": "POST", "path": "/v2/charges",
                  "gateway": [
                    { "entry": { "repo": "forge-edge-gateway", "fact": "e1", "component": "edge-gateway", "at": "proxies/forge-pay-v1/apiproxy/proxies/default.xml:13" },
                      "call": { "repo": "forge-edge-gateway", "fact": "c1", "component": "edge-gateway", "at": "x:1" },
                      "route": "gw-edge-post-pay-v1-charges", "auth": "apikey", "scopes": [], "facing": "internal" },
                    { "entry": { "repo": "forge-partner-gateway", "fact": "e2", "component": "partner-gateway", "at": "proxies/northwind-pay-v1/apiproxy/proxies/default.xml:10" },
                      "call": { "repo": "forge-partner-gateway", "fact": "c2", "component": "partner-gateway", "at": "y:2" },
                      "route": "gw-partner-post-pay-v1-charges", "auth": "oauth2",
                      "scopes": ["northwind.charges.write"], "facing": "external" } ],
                  "scopes": ["northwind.charges.write"] } ] }
            """.trimIndent()
        val row = CallPaths.rows(json).single()
        assertEquals(
            "forge-orders → gw-edge-post-pay-v1-charges → gw-partner-post-pay-v1-charges → northwind-pay-api",
            row.label,
        )
        assertTrue(row.detail.contains("POST /v2/charges"), row.detail)
        assertTrue(row.detail.contains("2 gateway hops"), row.detail)
        assertTrue(row.detail.contains("scopes northwind.charges.write"), row.detail)
        assertEquals(listOf("internal", "external"), row.hops.map { it.facing })
        assertTrue(row.hops[1].detail.contains("auth oauth2"), row.hops[1].detail)
        assertTrue(row.hops[1].detail.contains("scopes northwind.charges.write"), row.hops[1].detail)
        assertTrue(row.hops[0].detail.contains("apiproxy/proxies/default.xml:13"), row.hops[0].detail)
    }

    @Test
    fun `a call that goes through no gateway has no hops`() {
        val json =
            """
            { "joins": [ { "call": { "repo": "forge-shop-bff", "at": "a:1" }, "entry": { "repo": "forge-orders", "at": "b:2" },
                           "method": "GET", "path": "/orders/{id}" } ] }
            """.trimIndent()
        val row = CallPaths.rows(json).single()
        assertEquals(emptyList<HopRow>(), row.hops)
        assertEquals("forge-shop-bff → forge-orders", row.label)
    }

    // ------------------------------------------------------------------ needs and findings

    @Test
    fun `the open needs of every change are read, with who handles them`() {
        val json =
            """
            [ { "change": "add-transfer-limit", "item": "n-dpia", "kind": "assessment", "title": "A DPIA for the new limit",
                "for": "change", "status": "open", "handledBy": "privacy", "verified": false },
              { "change": "add-transfer-limit", "item": "n-queue", "title": "A queue on the bus", "for": "story s1",
                "status": "done", "verified": true } ]
            """.trimIndent()
        val rows = Needs.rows(json)
        assertEquals(2, rows.size)
        assertEquals(listOf("n-dpia"), Needs.open(rows).map { it.item })
        assertTrue(rows[0].detail.contains("handled by privacy"), rows[0].detail)
        assertTrue(rows[1].detail.contains("for story s1"), rows[1].detail)
    }

    @Test
    fun `a finding offers the critic's own actions, and never waives a constitution rule`() {
        val json =
            """
            [ { "id": "f-1", "change": "add-transfer-limit", "kind": "gap", "severity": "blocking",
                "waivable": true, "layer": "checklist", "summary": "No limit on the daily total",
                "fix": { "text": "add the cap", "patch": "--- a\n+++ b\n" }, "state": "open" },
              { "id": "f-2", "change": "add-transfer-limit", "kind": "gap", "severity": "blocking",
                "waivable": true, "layer": "constitution", "summary": "A person must approve the write",
                "fix": { "text": "ask a person" }, "state": "open" },
              { "id": "f-3", "change": "add-transfer-limit", "kind": "knowledge-gap", "severity": "gap",
                "summary": "Nobody says what the limit is", "fix": { "text": "ask" },
                "question": { "text": "What is the daily cap?", "owner": "payments-lead" }, "state": "open" },
              { "id": "f-4", "change": "add-transfer-limit", "kind": "idea", "severity": "idea",
                "summary": "Closed already", "fix": { "text": "" }, "state": "closed" } ]
            """.trimIndent()
        val rows = Findings.rows("add-transfer-limit", json)
        assertEquals(listOf("f-1", "f-2", "f-3"), rows.map { it.id }, "the closed one is left out")
        assertEquals(
            listOf("apply", "edit-and-apply", "not-relevant", "waive", "ask"),
            Findings.actions(rows[0]).map { it.action },
        )
        assertEquals(
            listOf("edit-and-apply", "not-relevant", "ask"),
            Findings.actions(rows[1]).map { it.action },
            "a constitution rule's finding is never waived, and it has no patch",
        )
        assertEquals(listOf("ask", "edit-and-apply"), Findings.actions(rows[2]).map { it.action })
        assertEquals("Ask payments-lead", Findings.actions(rows[2])[0].label)
        assertEquals(
            listOf("finding", "add-transfer-limit", "f-1", "not-relevant", "--reason", "the cap is in the gateway"),
            Findings.argv(rows[0], Findings.actions(rows[0])[2], "the cap is in the gateway"),
        )
        assertEquals(
            listOf("finding", "add-transfer-limit", "f-3", "ask", "--asked-of", "payments-lead"),
            Findings.argv(rows[2], Findings.actions(rows[2])[0].copy(needs = "asked-of"), "payments-lead"),
        )
    }

    // ------------------------------------------------------------------ what waits, grouped

    private val question = OpenQuestion("q-1", "forge-ledger", "Which service owns the cap?", emptyList(), emptyList())
    private val need = NeedRow("add-transfer-limit", "n-dpia", "A DPIA", "open", "change", "privacy")
    private val blocking = FindingRow("add-transfer-limit", "f-1", "No limit", "blocking", "gap", true)
    private val other = FindingRow("add-refund-window", "f-2", "No note", "risk", "gap", false)
    private val manual = Pick("s-1", "Open a firewall rule", "add-refund-window · waiting")

    private val items =
        listOf(
            WaitingItem.Question(question),
            WaitingItem.Finding(other),
            WaitingItem.Need(need),
            WaitingItem.Finding(blocking),
            WaitingItem.Manual(manual, null),
            WaitingItem.Knowledge(4),
        )

    @Test
    fun `by change, the change with something blocking comes first`() {
        val groups = WaitingRows.groups(items, Grouping.BY_CHANGE) { if (it == "add-transfer-limit") "Cap the transfers" else it }
        assertEquals(listOf("Cap the transfers", "add-refund-window", Copy.WAITING_NO_CHANGE), groups.map { it.first })
        // A change's needs come before its findings, as the addendum says.
        assertEquals(listOf(Copy.WAITING_NEEDS, Copy.WAITING_FINDINGS), groups[0].second.map { it.kind })
        assertEquals(listOf(Copy.WAITING_QUESTIONS, Copy.WAITING_MANUAL, Copy.WAITING_KNOWLEDGE), groups[2].second.map { it.kind })
    }

    @Test
    fun `by kind, each group says how many and an empty kind is left out`() {
        val groups = WaitingRows.groups(items.filter { it !is WaitingItem.Knowledge }, Grouping.BY_KIND)
        assertEquals(
            listOf("${Copy.WAITING_QUESTIONS} (1)", "${Copy.WAITING_NEEDS} (1)", "${Copy.WAITING_FINDINGS} (2)", "${Copy.WAITING_MANUAL} (1)"),
            groups.map { it.first },
        )
    }

    @Test
    fun `nothing waiting is no groups at all`() {
        assertEquals(emptyList<Pair<String, List<WaitingItem>>>(), WaitingRows.groups(emptyList(), Grouping.BY_CHANGE))
        assertEquals(emptyList<Pair<String, List<WaitingItem>>>(), WaitingRows.groups(emptyList(), Grouping.BY_KIND))
    }

    // ------------------------------------------------------------------ model runs and prompts

    @Test
    fun `a model run says its round, what was handed back and whether it was answered`() {
        val json =
            """
            { "runs": [
                { "runId": "r-2026-10-26-01", "change": "add-transfer-limit", "agent": "flow-architect",
                  "runtime": "copilot", "state": "handed-back", "startedAt": "2026-10-26T08:15:00Z",
                  "promptPath": ".runs/r1/prompt.md", "attempt": 2, "answered": true, "handedBack": 3 },
                { "runId": "r-2026-10-26-02", "change": "add-transfer-limit", "agent": "story-writer",
                  "runtime": "copilot", "state": "waiting", "startedAt": "2026-10-26T09:00:00Z",
                  "promptPath": ".runs/r2/prompt.md", "attempt": 1, "answered": false, "handedBack": 0 } ] }
            """.trimIndent()
        val rows = ModelRuns.rows(json)
        assertEquals(2, rows.size)
        assertTrue(rows[0].detail.contains("round 2"), rows[0].detail)
        assertTrue(rows[0].detail.contains("3 handed back"), rows[0].detail)
        assertTrue(rows[1].detail.contains("no answer yet"), rows[1].detail)
        assertEquals("#/runs?run=r-2026-10-26-01", ModelRuns.hash("r-2026-10-26-01"))
    }

    @Test
    fun `the prompt history says what was asked, where, and when nothing came back`() {
        val json =
            """
            { "recording": true, "total": 2, "turns": [
                { "at": "2026-10-26T08:00:00Z", "surface": "claude-code", "session": "s1",
                  "change": "add-transfer-limit",
                  "prompt": { "id": "p1", "text": "/atticus-stories add-transfer-limit\nsecond line" },
                  "response": { "id": "a1", "text": "Wrote four stories." } },
                { "at": "2026-10-26T08:30:00Z", "surface": "vscode", "session": "s2",
                  "prompt": { "id": "p2", "text": "what calls forge-ledger?" } } ] }
            """.trimIndent()
        assertTrue(History.recording(json))
        val rows = History.rows(json)
        assertEquals("/atticus-stories add-transfer-limit", rows[0].label)
        assertTrue(rows[0].detail.contains("claude-code"), rows[0].detail)
        assertTrue(rows[1].detail.contains(Copy.NO_RESPONSE_YET), rows[1].detail)
    }

    @Test
    fun `nothing printed leaves every view empty rather than failing`() {
        assertEquals(emptyList<RunRow>(), ModelRuns.rows("atticus: unknown command"))
        assertEquals(emptyList<PromptRow>(), History.rows(""))
        assertEquals(emptyList<ChangeRow>(), Changes.rows("{}"))
        assertEquals(emptyList<TaskKnowledgeRow>(), TaskKnowledge.rows("not json"))
        assertEquals(emptyList<CallPathRow>(), CallPaths.rows(""))
        assertEquals(emptyList<RepoRow>(), Repos.rows(dir.resolve("nowhere")))
    }
}
