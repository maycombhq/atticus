package com.maycombhq.atticus.ide

import com.intellij.execution.ExecutionException
import com.intellij.execution.RunContentExecutor
import com.intellij.execution.process.KillableProcessHandler
import com.intellij.ide.impl.ProjectUtil
import com.intellij.notification.NotificationType
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.ListSeparator
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import com.intellij.openapi.util.ThrowableComputable
import com.intellij.openapi.vfs.LocalFileSystem
import com.maycombhq.atticus.core.Answers
import com.maycombhq.atticus.core.Catalog
import com.maycombhq.atticus.core.CatalogArg
import com.maycombhq.atticus.core.CatalogCommand
import com.maycombhq.atticus.core.CatalogFlag
import com.maycombhq.atticus.core.CommandLine
import com.maycombhq.atticus.core.Commands
import com.maycombhq.atticus.core.Copy
import com.maycombhq.atticus.core.HowToRun
import com.maycombhq.atticus.core.Metarepo
import com.maycombhq.atticus.core.Next
import com.maycombhq.atticus.core.NextAction
import com.maycombhq.atticus.core.PickItem
import com.maycombhq.atticus.core.Words
import java.awt.datatransfer.StringSelection
import java.nio.file.Files
import java.nio.file.Path

/** An answer to one question: a value (null when left out), or the person cancelled. */
private class Got(val value: List<String>?)

/**
 * Run a command (ADR 0096, 0099): pick it, answer what it needs, and run it as its kind needs.
 * The logic is in core (Commands); this asks and shows.
 */
class CommandFlow(private val project: Project) {
    private val cwd = Roots.cwd(project)
    private val orgPack: Path? = Roots.metarepo(project)?.let { Metarepo.orgPack(it) }

    private fun <T> modal(title: String, work: () -> T): T =
        ProgressManager.getInstance().runProcessWithProgressSynchronously(ThrowableComputable<T, RuntimeException> { work() }, title, true, project)

    private fun cli(args: List<String>) = AtticusCli.run(project, cwd, args)

    fun catalog(): Catalog? {
        val r = modal("Reading atticus's commands") { cli(listOf("commands", "--json")) }
        return runCatching { Catalog.parse(r.stdout) }.getOrElse {
            Notify.show(project, "${Copy.NO_CATALOG}: ${Copy.firstLine(r.lines, r.code)}", NotificationType.WARNING, Notify.showOutput(project))
            null
        }
    }

    fun pickAndRun() {
        val cat = catalog() ?: return
        val groups = Commands.pickList(cat, AtticusSettings.get().state.showDeveloperCommands)
        val items = groups.flatMap { it.items }
        val heads = groups.associate { it.items.first().command.id to it.title }
        val step =
            object : BaseListPopupStep<PickItem>(Copy.PICK_TITLE, items) {
                override fun getTextFor(value: PickItem) = "${value.label}   (${value.description})"

                override fun getSeparatorAbove(value: PickItem) = heads[value.command.id]?.let { ListSeparator(it) }

                override fun isSpeedSearchEnabled() = true

                override fun onChosen(selectedValue: PickItem, finalChoice: Boolean): PopupStep<*>? =
                    doFinalStep { askAndRun(selectedValue.command) }
            }
        JBPopupFactory.getInstance().createListPopup(step, 20).showCenteredInCurrentWindow(project)
    }

    fun askAndRun(cmd: CatalogCommand) {
        val a = ask(cmd) ?: return
        run(cmd, Commands.buildArgv(cmd, a))
    }

    // ---------------------------------------------------------------- asking

    private fun pickOrType(title: String, message: String, values: List<String>): String? =
        Messages.showEditableChooseDialog(message, title, null, values.toTypedArray(), values.first(), null)

    private fun typed(title: String, prompt: String): String? = Messages.showInputDialog(project, prompt, title, null)

    private fun repos(): List<String> = orgPack?.let { Metarepo.repos(it) } ?: emptyList()

    private fun changes(): List<String> =
        Metarepo.changes(modal("Reading the changes") { cli(Commands.withRoot(listOf("change", "list", "--json"), cwd)) }.stdout).map { it.id }

    /** One value from a list; typed when the list is empty. */
    private fun fromList(title: String, values: List<String>, empty: String, hint: String): String? =
        if (values.isEmpty()) typed(title, "$empty $hint") else pickOrType(title, Copy.PICK_OR_TYPE, values)

    private fun askArg(cmd: CatalogCommand, a: CatalogArg): Got? {
        val title = Copy.argTitle(cmd, a)
        val hint = "${cmd.summary}${Copy.leaveEmpty(a.optional)}"
        val v: String? =
            when (a.kind) {
                "repo" -> fromList(title, repos(), Copy.NO_REPOS, hint)
                "change" -> fromList(title, changes(), Copy.NO_CHANGES, hint)
                "question" -> {
                    val qs = Metarepo.questions(modal("Reading the open questions") { cli(Commands.withRoot(listOf("questions", "list", "--state", "open", "--json"), cwd)) }.stdout)
                    fromList(title, qs.map { "${it.id}  —  ${it.question}" }, Copy.NO_QUESTIONS, hint)?.substringBefore("  —  ")
                }
                "choice" -> if (a.choices.isNullOrEmpty()) typed(title, hint) else pickOrType(title, cmd.summary, a.choices)
                "path" -> {
                    val d = PathDialog(project, title, hint, Regex("dir|folder").containsMatchIn(a.name), cwd)
                    if (d.showAndGet()) d.path() else null
                }
                else -> typed(title, hint)
            }
        if (v == null) return null
        val t = v.trim()
        if (t.isEmpty()) return if (a.optional) Got(null) else null
        return Got(if (a.many) t.split(Regex("\\s+")) else listOf(t))
    }

    private fun askFlag(cmd: CatalogCommand, f: CatalogFlag): String? {
        val title = "atticus ${cmd.id} ${f.name}"
        val v =
            when {
                cmd.id == "change new" && f.name == "--type" -> {
                    val file = orgPack?.resolve("change-types.yaml")
                    val types = file?.takeIf { Files.isRegularFile(it) }?.let { Commands.changeTypesFrom(Files.readString(it)) } ?: emptyList()
                    if (types.isEmpty()) typed(title, Copy.flagPrompt(f.value)) else pickOrType("The kind of change", Copy.PICK_OR_TYPE, types.map { it.id })
                }
                f.name == "--repo" -> fromList(title, repos(), Copy.NO_REPOS, Copy.flagPrompt(f.value))
                f.name == "--change" -> fromList(title, changes(), Copy.NO_CHANGES, Copy.flagPrompt(f.value))
                f.name == "--platform" && orgPack != null -> fromList(title, Metarepo.platforms(orgPack), "", Copy.PLATFORM)
                else -> typed(title, Copy.flagPrompt(f.value))
            }
        return v?.trim()?.takeIf { it.isNotEmpty() }
    }

    /** Each argument, then the required options, then any options to add. Null: the person cancelled. */
    fun ask(cmd: CatalogCommand): Answers? {
        val args = mutableListOf<List<String>?>()
        for (a in cmd.args) args += (askArg(cmd, a) ?: return null).value
        val flags = LinkedHashMap<String, String?>(Commands.requiredSwitches(cmd))
        var alternativeGiven = false
        for (f in Commands.requiredToAsk(cmd)) {
            val alt = Commands.isAlternative(cmd, f)
            if (alt && alternativeGiven) continue
            val v = askFlag(cmd, f)
            if (v == null) {
                if (alt) continue else return null
            }
            flags[f.name] = v
            if (alt) alternativeGiven = true
        }
        val options = Commands.optionsOf(cmd).filter { it.name !in flags }
        if (options.isNotEmpty()) {
            val d = OptionsDialog(project, cmd.id, options)
            if (!d.showAndGet()) return null
            flags.putAll(d.chosen())
        }
        return Answers(args, flags)
    }

    // ---------------------------------------------------------------- running

    /** Run a command as its kind needs (ADR 0099). */
    fun run(cmd: CatalogCommand?, argv: List<String>) {
        when (val how = cmd?.let { Commands.howToRun(it) } ?: HowToRun.Capture) {
            HowToRun.Ai -> aiStep(argv, Commands.slashFor(argv))
            is HowToRun.Approve -> approveAndRun(argv, how.flag)
            HowToRun.Console -> inConsole(cmd?.id ?: argv.take(2).joinToString(" "), argv)
            HowToRun.Capture -> captured(argv) { r -> if (cmd?.id == "change new" && r.ok) openBrief(r) else said(argv, r) }
        }
    }

    /** An AI step isn't run here: Copilot in IntelliJ offers plugins no model, so the person runs its slash command in Copilot Chat. */
    fun aiStep(argv: List<String>, slash: String?) {
        val actions =
            listOfNotNull(
                slash?.let { s -> Notify.action(Copy.copy(s)) { CopyPasteManager.getInstance().setContents(StringSelection(s)) } },
                Notify.action(Copy.RUN_HANDOFF) { inConsole("hand-off", Commands.handoff(argv)) },
            )
        Notify.show(project, Copy.aiStep(slash), NotificationType.INFORMATION, *actions.toTypedArray()).also { it.setTitle(Copy.AI_TITLE) }
    }

    /** A shared write: a dry run, the person's yes, then the run with the approve flag. Never the write without the yes. */
    fun approveAndRun(argv: List<String>, flag: String) {
        val dry = Commands.dryRun(argv, flag)
        val real = Commands.approved(argv, flag)
        background("atticus ${CommandLine.text(dry).removePrefix("atticus ")} (dry run)", { cli(Commands.withRoot(dry, cwd)) }) { r ->
            if (ApproveDialog(project, CommandLine.text(real), r).showAndGet()) captured(real) { said(real, it) }
        }
    }

    /** A server or a hand-off: in the Run tool window, with a Stop button. No shell. */
    fun inConsole(title: String, argv: List<String>) {
        val full = Commands.withRoot(argv, cwd)
        AtticusLog.of(project).line("> ${CommandLine.text(full)}")
        val h =
            try {
                KillableProcessHandler(AtticusCli.commandLine(cwd, full))
            } catch (e: ExecutionException) {
                Notify.show(project, Copy.couldNotRun(e.message ?: ""), NotificationType.ERROR)
                return
            }
        RunContentExecutor(project, h)
            .withTitle("Atticus: $title")
            .withActivateToolWindow(true)
            .withStop({ h.destroyProcess() }, { !h.isProcessTerminated })
            .run()
    }

    fun captured(argv: List<String>, cwdOverride: String? = null, then: (Ran) -> Unit) {
        val dir = cwdOverride ?: cwd
        background(CommandLine.text(argv), { AtticusCli.run(project, dir, Commands.withRoot(argv, dir)) }, then)
    }

    private fun <T> background(title: String, work: () -> T, then: (T) -> Unit) {
        ProgressManager.getInstance().run(
            object : Task.Backgroundable(project, "Atticus: $title", true) {
                private var result: T? = null

                override fun run(indicator: ProgressIndicator) {
                    result = work()
                }

                override fun onSuccess() {
                    @Suppress("UNCHECKED_CAST")
                    then(result as T)
                }
            },
        )
    }

    /** What it printed: the first line, and the rest in the Output tab. */
    fun said(argv: List<String>, r: Ran) {
        val id = argv.takeWhile { !it.startsWith("-") }.take(2).joinToString(" ")
        Notify.show(
            project,
            Copy.done(id, Copy.firstLine(r.lines, r.code)),
            if (r.ok) NotificationType.INFORMATION else NotificationType.WARNING,
            Notify.showOutput(project),
        )
    }

    private fun openBrief(r: Ran) {
        val rel = Commands.briefPathFrom(r.stdout)
        val file = rel?.let { LocalFileSystem.getInstance().refreshAndFindFileByNioFile(Path.of(cwd).resolve(it)) }
        if (file != null) FileEditorManager.getInstance(project).openFile(file, true)
        said(listOf("change", "new"), r)
    }
}

/** The next step (ADR 0099): in plain words, with what can be done about it. */
class NextFlow(private val project: Project) {
    fun show() {
        val flow = CommandFlow(project)
        val cwd = Roots.cwd(project)
        val r =
            ProgressManager.getInstance().runProcessWithProgressSynchronously(
                ThrowableComputable<Ran, RuntimeException> { AtticusCli.run(project, cwd, listOf("next", "--json", "--root", cwd)) },
                "Reading the next step",
                true,
                project,
            )
        val view = Next.parse(r.stdout)
        if (view == null) {
            Notify.show(project, Copy.couldNotReadNext(Copy.firstLine(r.lines, r.code)), NotificationType.WARNING, Notify.showOutput(project))
            return
        }
        val n = view.next
        if (n == null) {
            Notify.show(project, Copy.NO_NEXT)
            return
        }
        val action = Next.actionFor(n)
        val slash =
            when (action) {
                is NextAction.Ai -> action.slash
                is NextAction.Answer -> action.slash
                else -> null
            }
        val message =
            buildString {
                append(Words.stepTitle(n)).append("\n\n").append(n.why).append("\n\n")
                if (action is NextAction.Person) append(Copy.PERSON_STEP).append(' ')
                append(n.command)
                if (slash != null) append("\n\nIn Copilot Chat: ").append(slash)
            }
        val copy = { s: String -> CopyPasteManager.getInstance().setContents(StringSelection(s)) }
        val openApp = { AtticusWindow.showTab(project, Copy.APP_TAB) }
        val choices: List<Pair<String, () -> Unit>> =
            when (action) {
                is NextAction.Ai ->
                    listOfNotNull(
                        slash?.let { s -> Copy.copy(s) to { copy(s) } },
                        Copy.RUN_HANDOFF to { flow.inConsole("hand-off", Commands.handoff(action.args)) },
                    )
                is NextAction.Answer -> listOfNotNull(Copy.OPEN_APP to openApp, slash?.let { s -> Copy.copy(s) to { copy(s) } })
                is NextAction.Run ->
                    listOf(
                        Copy.RUN_IT to {
                            val cat = flow.catalog()
                            val cmd = cat?.let { Commands.matchCommand(it, action.args.joinToString(" ") { a -> if (a.contains(' ')) "\"$a\"" else a })?.first }
                            flow.run(cmd, action.args)
                        },
                    )
                is NextAction.Person -> listOf(Copy.OPEN_APP to openApp, Copy.copy("the command") to { copy(n.command) })
            }
        val buttons = choices.map { it.first } + Copy.CLOSE
        val i = Messages.showDialog(project, message, Copy.NEXT_TITLE, buttons.toTypedArray(), 0, Messages.getInformationIcon())
        choices.getOrNull(i)?.second?.invoke()
    }
}

/** Starting from nothing (ADR 0098, 0099): make a metarepo, adopt this project, or a practice one. */
class StartFlow(private val project: Project) {
    private val flow = CommandFlow(project)
    private val base = Roots.base(project)?.toString() ?: System.getProperty("user.home")

    private fun folder(title: String, prompt: String, initial: String): String? {
        val d = PathDialog(project, title, prompt, true, initial)
        return if (d.showAndGet()) d.path().takeIf { it.isNotEmpty() } else null
    }

    private fun offerToOpen(path: String) {
        val i = Messages.showDialog(project, Copy.openIt(path), Copy.TOOL_WINDOW, arrayOf(Copy.OPEN, Copy.NOT_NOW), 0, Messages.getQuestionIcon())
        if (i == 0) ProjectUtil.openOrImport(Path.of(path), project, true)
    }

    fun createMetarepo() {
        val title = Copy.CREATE_METAREPO.removeSuffix("…")
        val parent = folder(title, Copy.WHERE_METAREPO, Path.of(base).parent?.toString() ?: base) ?: return
        val name = Messages.showInputDialog(project, Copy.METAREPO_NAME, title, null)?.trim()?.takeIf { it.isNotEmpty() } ?: return
        val platform = Messages.showInputDialog(project, Copy.PLATFORM, title, null)?.trim()?.takeIf { it.isNotEmpty() } ?: return
        val dir = Path.of(parent).resolve(name).toString()
        val argv = listOf("init", dir, "--platform", platform)
        flow.captured(argv, parent) { r ->
            flow.said(argv, r)
            if (r.ok) offerToOpen(dir)
        }
    }

    fun adopt() {
        val argv = listOf("adopt", base)
        flow.captured(argv, base) { r ->
            flow.said(argv, r)
            if (r.ok) AtticusApp.of(project).refresh()
        }
    }

    fun sandbox() {
        val title = Copy.SANDBOX.removeSuffix("…")
        val parent = folder(title, Copy.WHERE_SANDBOX, Path.of(base).parent?.toString() ?: base) ?: return
        var dir = Path.of(parent).resolve("atticus-practice")
        var n = 2
        while (Files.exists(dir)) dir = Path.of(parent).resolve("atticus-practice-${n++}")
        val argv = listOf("sandbox", "create", dir.toString())
        flow.captured(argv, parent) { r ->
            flow.said(argv, r)
            if (r.ok) offerToOpen(dir.toString())
        }
    }
}
