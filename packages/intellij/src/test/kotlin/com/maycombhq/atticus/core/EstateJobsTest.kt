package com.maycombhq.atticus.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files

/**
 * ADR 0159: what 2.0.0-beta.10 added to the command line, as IntelliJ actions and rows: the
 * commands each action runs, the questions' owners, proposals and rules, and the Next tab's
 * reading order, costs, near ids and seed step. The JSON is the command line's own shape
 * (next-commands.ts, question-commands.ts, api.ts QuestionList).
 */
class EstateJobsTest {
    private fun argv(id: String, target: String? = null) = Steps.of(id)!!.argv(target)

    @Test
    fun `each new job runs the command the CLI documents`() {
        assertEquals(listOf("estate", "fresh"), argv("Atticus.EstateFresh"))
        assertEquals(listOf("next", "--queue"), argv("Atticus.ReadingQueue"))
        assertEquals(listOf("map", "forge-ledger", "--gaps"), argv("Atticus.MapGaps", "forge-ledger"))
        assertEquals(listOf("join", "measure", "reference.yaml"), argv("Atticus.JoinMeasure", "reference.yaml"))
        assertEquals(listOf("verify", "audit", "forge-ledger", "--report"), argv("Atticus.AuditReport", "forge-ledger"))
        assertEquals(listOf("change", "impact", "add-transfer-limit"), argv("Atticus.ChangeImpact", "add-transfer-limit"))
        assertEquals(listOf("spec", "seed", "forge-ledger"), argv("Atticus.SeedSpec", "forge-ledger"))
        assertEquals(listOf("spec", "accept", "forge-ledger"), argv("Atticus.AcceptSeed", "forge-ledger"))
        assertEquals(listOf("questions", "sheet"), argv("Atticus.QuestionsSheet"))
        assertEquals(listOf("questions", "sheet", "--apply", "questions-sheet.yaml"), argv("Atticus.ApplySheet", "questions-sheet.yaml"))
        assertEquals(listOf("questions", "proposed"), argv("Atticus.CheckProposals"))
        // Each answers VS Code's jobs.ts command for the same job, and runs as it stands.
        assertTrue(Steps.ESTATE.all { it.vsCode != null && it.direct && !it.ai })
        for (s in Steps.ESTATE) assertEquals(InIntelliJ.Action(s.actionId), Parity.MAP[s.vsCode], s.actionId)
    }

    @Test
    fun `the second pass on the gaps has its own slash command`() {
        assertEquals("/atticus-map forge-ledger --gaps", Commands.slashFor(listOf("map", "forge-ledger", "--gaps")))
        assertEquals("/atticus-map forge-ledger", Commands.slashFor(listOf("map", "forge-ledger")))
        assertEquals("/atticus-map forge-ledger --gaps", Commands.gapsSlash("forge-ledger"))
        val root = Files.createTempDirectory("atticus-gaps")
        assertNull(Commands.gapsPrompt(root, "forge-ledger"))
        Files.createDirectories(root.resolve("facts"))
        Files.writeString(root.resolve("facts/forge-ledger.gaps.md"), "# gaps")
        assertEquals(root.resolve("facts/forge-ledger.gaps.md"), Commands.gapsPrompt(root, "forge-ledger"))
        // The assistant's proposals have a slash command and no command line of their own.
        assertEquals(".github/prompts/atticus-propose.prompt.md", Peer.promptFileFor(Steps.PROPOSE_SLASH))
    }

    @Test
    fun `Map the Estate runs map --all at the limit typed, pre-filled from runtime yaml`() {
        assertEquals(listOf("map", "--all", "--max-tokens", "128000"), Commands.mapAllArgv(" 128,000 "))
        assertNull(Commands.mapAllArgv("12"))
        assertNull(Commands.mapAllArgv("a lot"))
        val op = Files.createTempDirectory("atticus-orgpack")
        assertNull(Commands.runtimeMaxInput(op))
        Files.writeString(op.resolve("runtime.yaml"), "schemaVersion: 2\nadapters:\n  model:\n    type: anthropic\n    settings:\n      maxInput: 200000 # the window\n")
        assertEquals("200000", Commands.runtimeMaxInput(op))
        assertNull(Commands.runtimeMaxInput(null))
        assertEquals(InIntelliJ.Action("Atticus.MapEstate"), Parity.MAP["atticus.mapEstate"])
    }

    @Test
    fun `a rename keeps one id, and a traffic export names its kind`() {
        assertEquals(listOf("repo", "rename", "Forge_Ledger", "forge-ledger"), Commands.renameArgv("Forge_Ledger", " forge-ledger "))
        assertNull(Commands.renameArgv("forge-ledger", "forge-ledger"))
        assertNull(Commands.renameArgv("forge-ledger", "forge ledger"))
        assertEquals(listOf("intake", "traffic", "export.csv", "--source", "apigee"), Commands.trafficArgv("export.csv", "apigee"))
        assertEquals(
            listOf("intake", "traffic", "export.csv", "--source", "catalog", "--from", "2026-10-01", "--to", "2026-10-31"),
            Commands.trafficArgv("export.csv", "catalog", "2026-10-01", "2026-10-31"),
        )
        // One date alone is no range: left out, as the command line takes both or neither.
        assertEquals(listOf("intake", "traffic", "export.csv", "--source", "catalog"), Commands.trafficArgv("export.csv", "catalog", "2026-10-01", null))
    }

    private val questions = """
        {
          "questions": [
            {"id": "q-0000000000a1", "repo": "forge-web", "state": "open", "question": "Which repo answers on payments.forge.internal?",
             "askedBy": {"step": "scan-hosts", "command": "atticus verify forge-web --write"},
             "options": [{"label": "forge-payments", "means": "the payments service"}, {"label": "An outside system (new)", "means": ""}],
             "evidence": ["src/client.ts:12"]},
            {"id": "q-0000000000b2", "repo": "add-transfer-limit", "state": "open", "question": "Who approves the limit?",
             "askedBy": {"step": "change-feature", "command": "atticus change feature add-transfer-limit"}, "options": [], "evidence": []},
            {"id": "q-0000000000c3", "repo": "forge-ping", "state": "answered", "question": "Done already", "askedBy": {"step": "x", "command": "y"}, "options": [], "evidence": []}
          ],
          "problems": [],
          "about": {
            "q-0000000000a1": {"restsOn": ["add-transfer-limit"], "joins": 4, "owner": {"team": "payments", "name": "Payments team"},
              "proposal": {"answer": {"option": 1}, "why": "The client's base URL is the payments host.",
                "cites": [{"repo": "forge-web", "file": "src/client.ts", "line": 12, "quote": "PAYMENTS_URL"}], "by": "copilot", "at": "2026-10-31T10:00:00Z", "file": "proposals/questions/q-0000000000a1.yaml"}},
            "q-0000000000b2": {"restsOn": [], "joins": 0, "owner": {"change": "add-transfer-limit", "people": ["sam", "ana"]}}
          },
          "me": {"handle": "sam", "teams": [{"id": "payments", "name": "Payments team"}]},
          "waiting": []
        }
    """.trimIndent()

    @Test
    fun `the open questions in the CLI's order, each with its owner and a checked proposal`() {
        val v = Waiting.listed(questions)!!
        assertEquals(listOf("q-0000000000a1", "q-0000000000b2"), v.questions.map { it.id })
        val hosts = v.questions[0]
        assertEquals(QuestionOwner.Team("payments", "Payments team"), hosts.owner)
        assertEquals(listOf("add-transfer-limit"), hosts.restsOn)
        assertEquals(4, hosts.joins)
        assertTrue(hosts.takesRule)
        assertEquals("1. forge-payments", hosts.proposedAnswer)
        assertEquals(listOf("forge-web/src/client.ts:12"), hosts.proposal!!.cites)
        assertEquals(
            "forge-web · team Payments team · add-transfer-limit rests on it · its answer joins 4 calls · a checked proposal waits",
            hosts.detail,
        )
        val own = v.questions[1]
        assertEquals(QuestionOwner.ChangePeople("add-transfer-limit", listOf("sam", "ana")), own.owner)
        assertEquals(false, own.takesRule)
        assertNull(own.proposal)
        assertEquals("add-transfer-limit · for sam, ana", own.detail)
        assertEquals(QuestionsMe("sam", listOf("Payments team")), v.me)
        assertNull(Waiting.listed("not json"))
    }

    @Test
    fun `an answer by rule, an accepted proposal, and my teams' questions`() {
        assertEquals(
            listOf("questions", "answer", "q-1", "--option", "1", "--match", "*.payments.forge.internal"),
            Peer.answerArgv("q-1", 1, null, " *.payments.forge.internal "),
        )
        assertEquals(listOf("questions", "answer", "q-1", "--text", "forge-payments"), Peer.answerArgv("q-1", null, "forge-payments", "  "))
        assertEquals(listOf("questions", "answer", "q-1", "--accept-proposal"), Peer.acceptArgv("q-1"))
        assertEquals(listOf("questions", "answer", "q-1", "--accept-proposal", "--match", "/forge/limits/**"), Peer.acceptArgv("q-1", "/forge/limits/**"))
        assertEquals(listOf("questions", "list", "--state", "open", "--mine"), Peer.questionsArgv(mine = true))
        assertEquals(listOf("questions", "list", "--state", "open"), Peer.questionsArgv(mine = false))
    }

    private val queue = """
        {
          "queue": [
            {"repo": "forge-gateway", "order": 2, "reason": "gateway", "why": "A gateway: its routes place the services behind it.",
             "command": "atticus map forge-gateway", "slash": "/atticus-map forge-gateway"},
            {"repo": "forge-ledger", "order": 1, "reason": "called", "why": "forge-web calls it.", "command": "atticus map forge-ledger", "slash": "/atticus-map forge-ledger",
             "cost": {"commit": "abc", "session": 136000, "estimated": {"tokens": 61200, "files": 40, "sessions": 2}, "read": {"parts": 0, "of": 2}}}
          ],
          "read": [
            {"repo": "forge-web", "cost": {"commit": "def", "session": 136000, "read": {"parts": 1, "of": 1, "at": "2026-10-30"},
              "reported": {"tokens": 1200000, "sessions": 1, "reports": 1}}, "stale": {"facts": "def", "head": "0123"}},
            {"repo": "forge-notify"}
          ],
          "problems": []
        }
    """.trimIndent()

    @Test
    fun `the reading order with why and what each read costs`() {
        val v = Queue.parse(queue)!!
        assertEquals(listOf("forge-ledger", "forge-gateway"), v.queue.map { it.repo })
        assertEquals("repos read so far call it · estimated about 61K tokens in 2 sessions · 0 of 2 parts read", v.queue[0].detail)
        assertEquals("a gateway · ${Copy.COST_NOT_ESTIMATED}", v.queue[1].detail)
        // A queued repo is taken as the Next tab takes a map step: an AI step with its slash command.
        assertEquals(NextAction.Ai(listOf("map", "forge-ledger"), "/atticus-map forge-ledger"), Next.actionFor(v.queue[0].step))
        assertEquals("1 of 1 part read · your assistant reported 1.2M tokens in 1 session · ${Copy.STALE_CLONE}", v.read[0].detail)
        assertEquals(Copy.NO_COST_ON_FILE, v.read[1].detail)
        assertEquals("950", Queue.tokens(950))
        assertNull(Queue.parse("No metarepo here"))
    }

    @Test
    fun `a near id is named with the rename that keeps one`() {
        val why =
            "forge_ledger isn't read yet: your assistant reads it. No facts are filed under forge_ledger, but forge-ledger has some (facts/forge-ledger.jsonl) and its id is near this one: if they are one repo, keep one id with atticus repo rename forge_ledger forge-ledger (or rename the facts to forge_ledger)."
        val n = Next.nearIds(NextStep(step = "map", command = "atticus map forge_ledger", why = why, repo = "forge_ledger"))
        assertEquals(listOf(NearId("forge_ledger", "forge-ledger", "facts/forge-ledger.jsonl")), n)
        assertEquals(listOf("repo", "rename", "forge_ledger", "forge-ledger"), n[0].rename)
        assertEquals(emptyList<NearId>(), Next.nearIds(NextStep(step = "map", command = "atticus map x", why = "x isn't read yet.")))
    }

    @Test
    fun `a re-read is an AI step, and a seed to accept is a person's step with its own action`() {
        val reread = NextStep(step = "reread", command = "atticus map forge-web", why = "Moved.", slash = "/atticus-map forge-web", repo = "forge-web")
        assertEquals(NextAction.Ai(listOf("map", "forge-web"), "/atticus-map forge-web"), Next.actionFor(reread))
        assertEquals("Read forge-web's changed files again with Copilot", Words.stepTitle(reread))
        val seed = NextStep(step = "accept-seed", command = "atticus spec accept forge-ledger", why = "Collides.", person = true, repo = "forge-ledger", change = "add-transfer-limit")
        assertEquals(NextAction.AcceptSeed("forge-ledger", "add-transfer-limit", "atticus spec accept forge-ledger"), Next.actionFor(seed))
        assertEquals("Accept forge-ledger's starting spec, then write add-transfer-limit's stories again", Words.stepTitle(seed))
        val root = Files.createTempDirectory("atticus-seed")
        assertNull(Commands.seedChange(root, "forge-ledger"))
        Files.createDirectories(root.resolve("openspec/changes/seed-forge-ledger"))
        assertEquals(root.resolve("openspec/changes/seed-forge-ledger"), Commands.seedChange(root, "forge-ledger"))
    }
}
