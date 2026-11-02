package com.maycombhq.atticus.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files

/**
 * ADR 0166: what 2.0.0-beta.11 added, caught up in the plugin. The "Another repo…" picker of a
 * target or topics question, a new system asked before it is written; the contract check's
 * counts; a repo type's notes and their rule drafts, run only after a yes; doctor --counts; and
 * Esc handed to the app's page in the tool window.
 */
class Beta11Test {
    private val q =
        OpenQuestion(
            "q-1",
            "forge-payments",
            "Which repo or system answers GET /limits/{id}, which payments-api calls?",
            listOf(QuestionOption("forge-accounts", ""), QuestionOption("Another repo…", ""), QuestionOption("None of these", "")),
            emptyList(),
            step = "facts-targets",
        )

    private val shown =
        """
        {
          "id": "q-1",
          "options": [],
          "picks": [
            { "id": "forge-accounts", "kind": "repo", "name": "forge-accounts", "read": false },
            { "id": "forge-ledger", "kind": "repo", "name": "forge-ledger (ledger-api)", "read": true },
            { "id": "harbor-audit", "kind": "system", "name": "Harbor Audit", "boundary": "internal" },
            { "id": "team-cards", "kind": "team", "name": "Cards team" },
            { "id": "team-ledger-ops", "kind": "team", "name": "Ledger Ops",
              "adds": { "id": "team-ledger-ops-system", "name": "Ledger Ops's system", "boundary": "internal", "owner": "team-ledger-ops" } }
          ]
        }
        """.trimIndent()

    @Test
    fun `Another repo opens the picker instead of answering`() {
        assertTrue(Beta11.opensPicker(q, 2))
        assertFalse(Beta11.opensPicker(q, 1))
        assertFalse(Beta11.opensPicker(q, null))
        val topic = q.copy(options = listOf(QuestionOption("A topic owned by another team or vendor", "")), step = "facts-topics")
        assertTrue(Beta11.opensPicker(topic, 1))
        assertEquals(listOf("questions", "show", "q-1", "--json"), Beta11.showArgv("q-1"))
    }

    @Test
    fun `the picker is read from questions show --json, and an older command line gives none`() {
        val picks = Beta11.picks(shown)!!
        assertEquals(listOf("forge-accounts", "forge-ledger", "harbor-audit", "team-cards", "team-ledger-ops"), picks.map { it.id })
        assertEquals(AddsSystem("team-ledger-ops-system", "Ledger Ops's system", "team-ledger-ops"), picks.last().adds)
        assertNull(Beta11.picks("""{ "id": "q-1" }"""))
        assertNull(Beta11.picks("not json"))
        assertEquals("forge-accounts  —  repo, not read yet", Beta11.line(picks[0]))
        assertEquals("forge-ledger  —  repo, read, forge-ledger (ledger-api)", Beta11.line(picks[1]))
        assertEquals("harbor-audit  —  system, internal, Harbor Audit", Beta11.line(picks[2]))
        assertEquals("team-ledger-ops  —  team, Ledger Ops, no system yet: adds one to the profile, after your yes", Beta11.line(picks[4]))
        assertEquals("harbor-audit", Beta11.targetOf(Beta11.line(picks[2])))
        assertEquals("Tidewater Clearing", Beta11.targetOf(" Tidewater Clearing "))
        // A topic's owner is a system or a team.
        assertEquals(listOf("harbor-audit", "team-cards", "team-ledger-ops"), Beta11.shown(picks, "facts-topics").map { it.id })
        assertEquals(5, Beta11.shown(picks, "facts-targets").size)
    }

    @Test
    fun `a repo, a system or a team with one answers as it is, anything else is offered first`() {
        val picks = Beta11.picks(shown)!!
        assertEquals(TargetPlan.Answer("forge-accounts"), Beta11.plan(picks, "forge-accounts"))
        assertEquals(TargetPlan.Answer("harbor-audit"), Beta11.plan(picks, "Harbor-Audit"))
        assertEquals(TargetPlan.Answer("team-cards"), Beta11.plan(picks, "team-cards"))
        assertEquals(TargetPlan.Offer("team-ledger-ops", "team-ledger-ops-system", "Ledger Ops's system", vendor = false, owner = "team-ledger-ops"), Beta11.plan(picks, "team-ledger-ops"))
        assertEquals(TargetPlan.Offer("Tidewater Clearing", "tidewater-clearing", "Tidewater Clearing", vendor = true), Beta11.plan(picks, "Tidewater Clearing"))
        assertNull(Beta11.plan(picks, "  "))
        assertEquals(listOf("questions", "answer", "q-1", "--target", "harbor-audit"), Beta11.targetArgv("q-1", "harbor-audit"))
        assertEquals(
            listOf("questions", "answer", "q-1", "--target", "Tidewater Clearing", "--add-system", "vendor", "--match", "/forge/limits/**"),
            Beta11.targetArgv("q-1", "Tidewater Clearing", "vendor", " /forge/limits/** "),
        )
        val ask = Copy.addSystemAsk(Beta11.plan(picks, "Tidewater Clearing") as TargetPlan.Offer, "atticus questions answer q-1 --target \"Tidewater Clearing\" --add-system vendor")
        assertTrue(ask.contains("(id tidewater-clearing)"), ask)
        assertTrue(ask.contains("--add-system vendor"), ask)
        assertTrue(ask.endsWith("Nothing is committed or pushed."), ask)
    }

    @Test
    fun `the contract check's counts in the status bar`() {
        val json = """{ "links": [], "findings": [], "counts": { "links": 12, "compared": 9, "mismatches": 3, "unconfirmed": 2 }, "notes": [] }"""
        val c = Beta11.contractCounts(json)
        assertEquals(ContractCounts(12, 9, 3, 2), c)
        assertEquals("3 contract mismatches", Beta11.contractsStatus(c))
        assertEquals("Atticus: 2 questions · 3 contract mismatches", Peer.statusText(2, null, 0, Beta11.contractsStatus(c)))
        assertEquals("Contract check: 3 mismatches, 2 unconfirmed, on 9 links compared (Map › Mismatches).", Beta11.contractsWords(c))
        assertNull(Beta11.contractsStatus(c!!.copy(mismatches = 0)))
        assertEquals("1 contract mismatch", Beta11.contractsStatus(c.copy(mismatches = 1)))
        assertEquals(Copy.CONTRACTS_NONE, Beta11.contractsWords(ContractCounts(4, 0, 0, 0)))
        assertNull(Beta11.contractCounts("{}"))
        assertEquals(listOf("join", "contracts"), Beta11.CONTRACTS_ARGV)
        assertEquals("#/mismatches", Beta11.MISMATCHES_SCREEN)
    }

    @Test
    fun `a repo type's notes, a note added and the rule drafts`() {
        assertEquals(listOf("repo-type", "note", "spring-service"), Beta11.noteArgv("spring-service"))
        assertEquals(listOf("repo-type", "note", "--org-wide"), Beta11.noteArgv(null))
        assertEquals(listOf("repo-type", "note", "spring-service", "--add", "Every call to the ledger uses mTLS"), Beta11.noteArgv("spring-service", "Every call to the ledger uses mTLS"))
        assertEquals("two lines", Beta11.noteOf(" two\n lines "))
        assertNull(Beta11.noteOf("  "))
        assertNull(Beta11.noteOf("x".repeat(1001)))
        assertEquals(listOf("repo-type", "rules", "--save"), Beta11.RULES_SAVE_ARGV)
        assertTrue(Copy.noteConfirm("spring-service", "atticus repo-type note spring-service --add x").contains("org-pack/repo-types/spring-service/type.yaml"))
        assertTrue(Copy.noteConfirm(null, "x").contains("org-pack/conventions.yaml"))
        assertTrue(Copy.rulesSaveConfirm("atticus repo-type rules --save").contains("atticus repo-type rules --save"))
        val op = Files.createTempDirectory("atticus-orgpack")
        assertEquals(emptyList<String>(), Beta11.repoTypes(op))
        for (t in listOf("spring-service", "apigee-proxy", "half-made")) Files.createDirectories(op.resolve("repo-types").resolve(t))
        Files.writeString(op.resolve("repo-types/spring-service/type.yaml"), "schemaVersion: 2\n")
        Files.writeString(op.resolve("repo-types/apigee-proxy/type.yaml"), "schemaVersion: 2\n")
        assertEquals(listOf("apigee-proxy", "spring-service"), Beta11.repoTypes(op))
        assertEquals(emptyList<String>(), Beta11.repoTypes(null))
    }

    @Test
    fun `doctor --counts and Esc handed to the page`() {
        assertEquals(listOf("doctor", "--counts"), Beta11.COUNTS_ARGV)
        assertTrue(Beta11.ESCAPE_TO_PAGE.contains("key:'Escape'"))
        assertTrue(Beta11.ESCAPE_TO_PAGE.contains("bubbles:true"))
        assertTrue(Beta11.ESCAPE_TO_PAGE.contains("document.activeElement"))
    }

    @Test
    fun `beta 11's VS Code commands are placed as actions of their own`() {
        for ((cmd, action) in listOf(
            "atticus.contractMismatches" to "Atticus.ContractMismatches",
            "atticus.repoTypeNotes" to "Atticus.RepoTypeNotes",
            "atticus.repoTypeAddNote" to "Atticus.AddNote",
            "atticus.repoTypeRules" to "Atticus.DraftRules",
            "atticus.repoTypeRulesSave" to "Atticus.SaveRules",
            "atticus.doctorCounts" to "Atticus.DoctorCounts",
        )) assertEquals(InIntelliJ.Action(action), Parity.MAP[cmd], cmd)
    }
}
