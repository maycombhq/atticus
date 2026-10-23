package com.maycombhq.atticus.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Every command from `atticus commands --json` (ADR 0096, 0099). The fixture is that command's
 * real output; the plugin reads it the same way at run time.
 */
class CommandsTest {
    private val catalog = Catalog.parse(javaClass.getResource("/fixtures/commands.json")!!.readText())

    private fun cmd(id: String) = catalog.commands.first { it.id == id }

    @Test
    fun `reads every command, its arguments, options and how it runs`() {
        assertTrue(catalog.commands.size > 100)
        assertEquals("start", catalog.areas.first().id)
        val survey = cmd("scan survey")
        assertEquals(listOf("scan", "survey"), survey.words)
        assertEquals(Runs.AI, survey.runs)
        assertEquals(CatalogArg("repo", "repo", optional = false, many = false), survey.args.single())
        assertEquals(CatalogFlag("--attempts", "3", required = false), survey.flags.first())
        assertEquals("--approve", cmd("change handoff").approve)
        assertEquals(Runs.SHARED, cmd("change handoff").runs)
        assertEquals(Runs.SERVE, cmd("ui").runs)
        assertEquals(listOf("github", "azure", "gitlab", "jenkins"), cmd("ci snippet").args.single().choices)
    }

    @Test
    fun `an unknown way of running is run as a local command`() {
        val c = Catalog.parse("""{"areas": [], "commands": [{"id": "x", "words": ["x"], "usage": "atticus x", "summary": "X", "args": [], "flags": [], "area": "start", "runs": "later"}]}""")
        assertEquals(Runs.LOCAL, c.commands.single().runs)
    }

    @Test
    fun `the list is by area, plain words first, without the developers' commands`() {
        val groups = Commands.pickList(catalog)
        assertEquals(
            listOf("Set up and keep healthy", "Repos, scans and specs", "Knowledge and documents", "The catalog", "Changes, findings and questions", "Plans, tasks and work items", "Release"),
            groups.map { it.title },
        )
        val survey = groups.flatMap { it.items }.first { it.command.id == "scan survey" }
        assertEquals("Your assistant reads the repo and drafts its scan settings", survey.label)
        assertEquals("scan survey <repo> · in Copilot Chat", survey.description)
        val handoff = groups.flatMap { it.items }.first { it.command.id == "change handoff" }
        assertEquals("change handoff <id> --approve · asks you before it writes", handoff.description)
        assertFalse(groups.flatMap { it.items }.any { it.command.area == "developer" })
        assertTrue(Commands.pickList(catalog, developer = true).any { it.title == "For Atticus's own quality" })
    }

    @Test
    fun `a command whose area isn't listed goes under Other`() {
        val c = Catalog.parse("""{"areas": [{"id": "start", "title": "Set up"}], "commands": [{"id": "x", "words": ["x"], "usage": "atticus x", "summary": "Does x", "args": [], "flags": [], "area": "new", "runs": "local"}]}""")
        assertEquals(listOf("Other"), Commands.pickList(c).map { it.title })
    }

    @Test
    fun `the arguments in order, then the options`() {
        val a = Answers(args = listOf(listOf("Let a reader tag notes")), flags = linkedMapOf("--type" to "feature"))
        assertEquals(listOf("change", "new", "Let a reader tag notes", "--type", "feature"), Commands.buildArgv(cmd("change new"), a))
        val b = Answers(args = listOf(listOf("forge-web")), flags = linkedMapOf("--force" to null))
        assertEquals(listOf("scan", "survey", "forge-web", "--force"), Commands.buildArgv(cmd("scan survey"), b))
        val left = Answers(args = listOf(null), flags = linkedMapOf())
        assertEquals(listOf("scan", "survey"), Commands.buildArgv(cmd("scan survey"), left))
    }

    @Test
    fun `how each command runs`() {
        assertEquals(HowToRun.Ai, Commands.howToRun(cmd("spec draft")))
        assertEquals(HowToRun.Approve("--approve"), Commands.howToRun(cmd("change handoff")))
        assertEquals(HowToRun.Approve("--send"), Commands.howToRun(cmd("digest")))
        assertEquals(HowToRun.Console, Commands.howToRun(cmd("ui")))
        assertEquals(HowToRun.Capture, Commands.howToRun(cmd("critic")))
    }

    @Test
    fun `a shared write runs first without its approve flag, then with it`() {
        val argv = listOf("change", "handoff", "add-note-tags", "--approve", "--repo")
        assertEquals(listOf("change", "handoff", "add-note-tags", "--repo"), Commands.dryRun(argv, "--approve"))
        assertEquals(listOf("change", "handoff", "add-note-tags", "--repo", "--approve"), Commands.approved(argv, "--approve"))
    }

    @Test
    fun `the metarepo is passed to every command except the ones that make one`() {
        assertEquals(listOf("scan", "forge-web", "--root", "C:/m"), Commands.withRoot(listOf("scan", "forge-web"), "C:/m"))
        assertEquals(listOf("init", "notes", "--platform", "forge"), Commands.withRoot(listOf("init", "notes", "--platform", "forge"), "C:/m"))
        assertEquals(listOf("adopt", "C:/r"), Commands.withRoot(listOf("adopt", "C:/r"), "C:/m"))
        assertEquals(listOf("sandbox", "create", "C:/s"), Commands.withRoot(listOf("sandbox", "create", "C:/s"), "C:/m"))
        assertEquals(listOf("sandbox", "list", "--root", "C:/m"), Commands.withRoot(listOf("sandbox", "list"), "C:/m"))
        assertEquals(listOf("scan", "--root", "C:/x"), Commands.withRoot(listOf("scan", "--root", "C:/x"), "C:/m"))
    }

    @Test
    fun `the options a person may add leave out what the plugin sets itself and the approve flag`() {
        assertEquals(listOf("--attempts", "--force"), Commands.optionsOf(cmd("spec draft")).map { it.name })
        assertFalse(Commands.optionsOf(cmd("digest")).any { it.name in setOf("--send", "--json") })
        assertTrue(Commands.optionsOf(cmd("digest")).any { it.name == "--channel" })
    }

    @Test
    fun `the required options to ask for leave out the approve flag, and a switch is set, not asked`() {
        assertEquals(emptyList<String>(), Commands.requiredToAsk(cmd("change handoff")).map { it.name })
        assertEquals(listOf("--type"), Commands.requiredToAsk(cmd("change new")).map { it.name })
        assertEquals(listOf("--platform"), Commands.requiredToAsk(cmd("init")).map { it.name })
        val c = Catalog.parse("""{"areas": [], "commands": [{"id": "x", "words": ["x"], "usage": "", "summary": "", "args": [], "flags": [{"name": "--resume", "required": true}], "area": "a", "runs": "local"}]}""")
        assertEquals(mapOf("--resume" to null), Commands.requiredSwitches(c.commands.single()))
    }

    @Test
    fun `an AI step's slash command in Copilot Chat, with its repo or change`() {
        assertEquals("/atticus-survey forge-web", Commands.slashFor(listOf("scan", "survey", "forge-web")))
        assertEquals("/atticus-verify forge-web", Commands.slashFor(listOf("scan", "verify", "forge-web", "--force")))
        assertEquals("/atticus-spec forge-web", Commands.slashFor(listOf("spec", "draft", "forge-web")))
        assertEquals("/atticus-knowledge", Commands.slashFor(listOf("knowledge", "scan")))
        assertEquals("/atticus-feature add-note-tags", Commands.slashFor(listOf("change", "feature", "add-note-tags")))
        assertEquals("/atticus-architecture add-note-tags", Commands.slashFor(listOf("change", "architecture", "add-note-tags")))
        assertEquals("/atticus-stories add-note-tags", Commands.slashFor(listOf("plan", "stories", "add-note-tags")))
        assertEquals("/atticus-plan add-note-tags", Commands.slashFor(listOf("change", "draft", "add-note-tags")))
        assertEquals("/atticus-needs add-note-tags", Commands.slashFor(listOf("change", "needs", "add-note-tags")))
        assertEquals("/atticus-find Kafka topic", Commands.slashFor(listOf("knowledge", "find", "Kafka topic")))
        assertNull(Commands.slashFor(listOf("scan", "forge-web")))
    }

    @Test
    fun `every AI step the command line has is one, with or without a slash command`() {
        for (s in listOf("change needs", "knowledge find", "knowledge ask", "knowledge scan", "change draft")) assertTrue(s in Commands.AI_STEPS, s)
        assertNull(Commands.slashFor(listOf("knowledge", "ask", "Who owns the ledger?")))
        assertEquals("#/change-diagram?change=add%20transfer", Commands.changeDiagramHash("add transfer"))
        assertEquals("#/estimate?change=add%20transfer", Commands.estimateHash("add transfer"))
        // The critic's AI lenses, one at a time; its stats and --resume aren't AI steps.
        assertTrue(Commands.isAiStep(listOf("critic", "add-transfer-limit")))
        assertTrue(!Commands.isAiStep(listOf("critic", "stats")))
        assertTrue(!Commands.isAiStep(listOf("critic", "add-transfer-limit", "--resume")))
    }

    @Test
    fun `the hand-off runs the AI step's deterministic half, for a model run elsewhere`() {
        assertEquals(listOf("scan", "survey", "forge-web", "--handoff"), Commands.handoff(listOf("scan", "survey", "forge-web")))
        assertEquals(listOf("scan", "survey", "--handoff"), Commands.handoff(listOf("scan", "survey", "--handoff")))
    }

    @Test
    fun `the command a typed line names, the longest that fits`() {
        val m = Commands.matchCommand(catalog, "atticus scan survey forge-web --force")
        assertNotNull(m)
        assertEquals("scan survey", m!!.first.id)
        assertEquals(listOf("forge-web", "--force"), m.second)
        assertEquals("change new", Commands.matchCommand(catalog, "change new \"Tag notes\" --type feature")!!.first.id)
        assertEquals(listOf("Tag notes", "--type", "feature"), Commands.matchCommand(catalog, "change new \"Tag notes\" --type feature")!!.second)
        assertNull(Commands.matchCommand(catalog, "no-such-command"))
    }

    @Test
    fun `the brief change new asks for, to open it`() {
        assertEquals("changes/add-note-tags/brief.md", Commands.briefPathFrom("Started add-note-tags.\nWrite the brief: changes/add-note-tags/brief.md\n"))
        assertNull(Commands.briefPathFrom("Done."))
    }

    @Test
    fun `the change types in change-types yaml`() {
        val yaml = """
            schemaVersion: 1
            types:
              - id: feature
                name: A new feature
                stages: [define]
              - id: "bug-fix"
              - id: platform
                name: 'Platform work'
        """.trimIndent()
        assertEquals(
            listOf(ChangeType("feature", "A new feature"), ChangeType("bug-fix", null), ChangeType("platform", "Platform work")),
            Commands.changeTypesFrom(yaml),
        )
    }

    @Test
    fun `the app is started to stop with the IDE, when the command line knows how`() {
        assertEquals(
            listOf("ui", "--port", "0", "--root", "C:/forge-meta", "--parent", "4242"),
            Commands.uiArgs("C:/forge-meta", catalog, 4242),
        )
        // An older command line without --parent: the app still starts, as before.
        val old = Catalog(catalog.areas, catalog.commands.map { c -> if (c.id == "ui") c.copy(flags = c.flags.filter { it.name != "--parent" }) else c })
        assertEquals(listOf("ui", "--port", "0", "--root", "C:/forge-meta"), Commands.uiArgs("C:/forge-meta", old, 4242))
        assertEquals(listOf("ui", "--port", "0", "--root", "C:/forge-meta"), Commands.uiArgs("C:/forge-meta", null, 4242))
    }

    @Test
    fun `the prompt file a hand-off printed, to open after it`() {
        val out = "Prompt: .runs/knowledge-scan/run-20261023034002-0001/prompt.md\nResult file: .runs/knowledge-scan/run-20261023034002-0001/knowledge-items.yaml\n"
        assertEquals(".runs/knowledge-scan/run-20261023034002-0001/prompt.md", Commands.promptPathFrom(out))
        assertNull(Commands.promptPathFrom("Scanned 7 repos."))
    }
}
