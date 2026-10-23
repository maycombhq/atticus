package com.maycombhq.atticus.core

/** What a person answered for a command: one entry per argument (null: left out), then options. */
data class Answers(
    val args: List<List<String>?>,
    /** Option name → its value, or null for a switch. In the order they were given. */
    val flags: LinkedHashMap<String, String?>,
)

/** How the plugin runs a command (ADR 0099). */
sealed interface HowToRun {
    /** An AI step: the person runs it in Copilot Chat with its slash command; no model is called here. */
    data object Ai : HowToRun

    /** A write to a shared system: a dry run first, then the person's yes, then the run with [flag]. */
    data class Approve(val flag: String) : HowToRun

    /** A server or another long run: in a console that keeps running, with a Stop button. */
    data object Console : HowToRun

    /** The rest: run, keep what it printed, say the first line. */
    data object Capture : HowToRun
}

data class PickItem(val command: CatalogCommand, val label: String, val description: String)

data class PickGroup(val title: String, val items: List<PickItem>)

data class ChangeType(val id: String, val name: String?)

object Commands {
    /** Options the plugin sets itself, never offered: the metarepo, JSON output, the run mode. */
    private val SET_BY_US = setOf("--root", "--json", "--handoff", "--resume", "--mode")

    /** The commands that make or adopt a metarepo: they take no --root. */
    private val NO_ROOT = listOf(listOf("init"), listOf("adopt"), listOf("sandbox", "create"))

    /** Each AI step's prompt file in Copilot Chat, written by `atticus assistant-files`. */
    private val SLASH =
        mapOf(
            "scan survey" to "/atticus-survey",
            "scan verify" to "/atticus-verify",
            "spec draft" to "/atticus-spec",
            "knowledge scan" to "/atticus-knowledge",
            "change feature" to "/atticus-feature",
            "change architecture" to "/atticus-architecture",
            "plan stories" to "/atticus-stories",
            "change draft" to "/atticus-plan",
            "change needs" to "/atticus-needs",
            "knowledge find" to "/atticus-find",
        )

    /** The AI steps, by their first two words: those with a slash command, and knowledge ask (a hand-off only). */
    val AI_STEPS: Set<String> = SLASH.keys + "knowledge ask"

    private val HOW =
        mapOf(
            Runs.AI to "in Copilot Chat",
            Runs.SHARED to "asks you before it writes",
            Runs.SERVE to "keeps running",
        )

    /**
     * Every command, by area, for the list a person picks from: what it does first, the command
     * and how it runs beside it. The commands only Atticus's own developers use are left out
     * unless asked for.
     */
    fun pickList(c: Catalog, developer: Boolean = false): List<PickGroup> {
        val known = c.areas.map { it.id }.toSet()
        val areas = c.areas.filter { developer || it.id != "developer" } + Area("", "Other")
        return areas.mapNotNull { a ->
            val these = c.commands.filter { if (a.id.isNotEmpty()) it.area == a.id else it.area !in known }
            if (these.isEmpty()) return@mapNotNull null
            PickGroup(
                a.title,
                these.map { x ->
                    val usage = x.usage.removePrefix("atticus ")
                    val how = HOW[x.runs]
                    PickItem(x, Words.commandTitle(x.summary).ifEmpty { usage }, if (how != null) "$usage · $how" else usage)
                },
            )
        }
    }

    fun buildArgv(cmd: CatalogCommand, a: Answers): List<String> {
        val out = cmd.words.toMutableList()
        for (v in a.args) if (v != null) out += v
        for ((name, v) in a.flags) {
            out += name
            if (v != null) out += v
        }
        return out
    }

    fun howToRun(cmd: CatalogCommand): HowToRun =
        when {
            cmd.runs == Runs.AI -> HowToRun.Ai
            cmd.runs == Runs.SHARED && cmd.approve != null -> HowToRun.Approve(cmd.approve)
            cmd.runs == Runs.SERVE -> HowToRun.Console
            else -> HowToRun.Capture
        }

    /** The command without its approve flag: what it would do, written nowhere shared. */
    fun dryRun(argv: List<String>, flag: String): List<String> = argv.filter { it != flag }

    /** The command with its approve flag, once the person said yes. */
    fun approved(argv: List<String>, flag: String): List<String> = dryRun(argv, flag) + flag

    /** Every command runs in the metarepo, except the ones that make one. */
    fun withRoot(argv: List<String>, root: String): List<String> {
        if ("--root" in argv) return argv
        if (NO_ROOT.any { w -> argv.take(w.size) == w }) return argv
        return argv + listOf("--root", root)
    }

    /** The options a person may add: not the ones the plugin sets, not the approve flag, not the required ones. */
    fun optionsOf(cmd: CatalogCommand): List<CatalogFlag> =
        cmd.flags.filter { !it.required && it.name !in SET_BY_US && it.name != cmd.approve }

    /** Required options that take a value, to ask for. The approve flag is never asked: approving adds it. */
    fun requiredToAsk(cmd: CatalogCommand): List<CatalogFlag> =
        cmd.flags.filter { it.required && it.value != null && it.name != cmd.approve && it.name !in SET_BY_US }

    /** Required options that take no value (`--resume`): set, never asked. */
    fun requiredSwitches(cmd: CatalogCommand): Map<String, String?> =
        cmd.flags.filter { it.required && it.value == null && it.name != cmd.approve }.associate { it.name to null }

    /** Two required options joined by "|" in the usage (`--option <n> | --text "..."`): one of them is enough. */
    fun isAlternative(cmd: CatalogCommand, flag: CatalogFlag): Boolean {
        val n = Regex.escape(flag.name)
        return Regex("$n[^|-]*\\|").containsMatchIn(cmd.usage) || Regex("\\|\\s*$n").containsMatchIn(cmd.usage)
    }

    /** The slash command that runs an AI step in Copilot Chat, with its repo or change. */
    fun slashFor(argv: List<String>): String? {
        val slash = SLASH[argv.take(2).joinToString(" ")] ?: return null
        val target = argv.getOrNull(2)?.takeIf { !it.startsWith("--") }
        return if (target != null) "$slash $target" else slash
    }

    /**
     * `atticus ui` for the tool window: on a free port, for the project. With `--parent <the IDE's pid>`
     * when the command line has it, so a killed IDE leaves no server behind; an older one starts as before.
     */
    fun uiArgs(root: String, catalog: Catalog?, idePid: Long): List<String> {
        val base = listOf("ui", "--port", "0", "--root", root)
        val ui = catalog?.commands?.firstOrNull { it.id == "ui" }
        return if (ui?.flags?.any { it.name == "--parent" } == true) base + listOf("--parent", idePid.toString()) else base
    }

    /** The AI step's deterministic half (`--handoff`): it writes the prompt for a model run elsewhere. */
    fun handoff(argv: List<String>): List<String> = if ("--handoff" in argv) argv else argv + "--handoff"

    /** The command a typed line names (the longest that fits), and the words after it. */
    fun matchCommand(c: Catalog, line: String): Pair<CatalogCommand, List<String>>? {
        val words = Next.argsOf(line.trim().let { if (it.startsWith("atticus ")) it else "atticus $it" })
        val best =
            c.commands
                .filter { it.words.isNotEmpty() && it.words.size <= words.size && words.take(it.words.size) == it.words }
                .maxByOrNull { it.words.size } ?: return null
        return best to words.drop(best.words.size)
    }

    /** The brief `atticus change new` asks for, relative to the metarepo. */
    fun briefPathFrom(out: String): String? = Regex("Write the brief: (\\S+)").find(out)?.groupValues?.get(1)

    /** The change types in `org-pack/change-types.yaml` (id and name), read without a YAML parser. */
    fun changeTypesFrom(yaml: String): List<ChangeType> {
        val out = mutableListOf<ChangeType>()
        val id = Regex("""^\s*-\s+id:\s*["']?([a-z0-9][a-z0-9._-]*)["']?\s*$""")
        val name = Regex("""^\s+name:\s*["']?(.+?)["']?\s*$""")
        for (line in yaml.lines()) {
            val i = id.find(line)
            if (i != null) {
                out += ChangeType(i.groupValues[1], null)
                continue
            }
            val n = name.find(line)
            val last = out.lastOrNull()
            if (n != null && last != null && last.name == null) out[out.size - 1] = last.copy(name = n.groupValues[1])
        }
        return out
    }
}
