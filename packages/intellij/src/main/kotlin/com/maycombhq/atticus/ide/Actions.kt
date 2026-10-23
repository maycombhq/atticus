package com.maycombhq.atticus.ide

import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.project.Project
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.notification.NotificationType
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.DumbAwareAction
import java.awt.datatransfer.StringSelection
import com.maycombhq.atticus.core.Commands
import com.maycombhq.atticus.core.Copy

/** The plugin's actions (Tools menu, the tool window's toolbar and Find Action). Their names are in plugin.xml. */
abstract class AtticusAction : DumbAwareAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }
}

class RunCommandAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        CommandFlow(e.project ?: return).pickAndRun()
    }
}

class NextStepAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        NextFlow(e.project ?: return).show()
    }
}

class RefreshAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        AtticusApp.of(e.project ?: return).reload()
    }
}

class OpenInBrowserAction : AtticusAction() {
    override fun update(e: AnActionEvent) {
        val p = e.project
        e.presentation.isEnabled = p != null && AtticusApp.of(p).state is AppState.Running
    }

    override fun actionPerformed(e: AnActionEvent) {
        val p = e.project ?: return
        when (val s = AtticusApp.of(p).state) {
            is AppState.Running -> BrowserUtil.browse(s.url)
            else -> Notify.show(p, Copy.APP_NOT_RUNNING)
        }
    }
}

/** Open a screen of the app in the Atticus tool window (ADR 0105, 0106). */
private fun openScreen(project: Project, hash: String) {
    ToolWindowManager.getInstance(project).getToolWindow("Atticus")?.show()
    AtticusApp.of(project).open(hash)
}

/** What waits on you across every change, grouped by change, in the app (#/home). */
class WaitingOnYouAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        openScreen(e.project ?: return, "#/home")
    }
}

/** A change's picture (ADR 0108): asks which change, then opens #/change-diagram on it. */
class ChangeDiagramAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val change =
            com.intellij.openapi.ui.Messages.showInputDialog(
                project,
                Copy.CHANGE_DIAGRAM_ASK,
                Copy.CHANGE_DIAGRAM,
                null,
            )?.trim()
        if (change.isNullOrEmpty()) return
        openScreen(project, Commands.changeDiagramHash(change))
    }
}

/** What Atticus asked a model and what came back (#/runs). */
class ModelRunsAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        openScreen(e.project ?: return, "#/runs")
    }
}

/** The files picked in the Project view that can be attached: files on this machine, not folders. */
private fun pickedFiles(e: AnActionEvent): List<String> =
    e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)
        ?.filter { !it.isDirectory && it.isInLocalFileSystem }
        ?.map { it.toNioPath().toString() }
        .orEmpty()

/**
 * ADR 0113: the files picked in the Project view, attached to a change (atticus change attach).
 * Asks which change; the change's steps then read them as data, cited by line or page.
 */
class AttachToChangeAction : AtticusAction() {
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && pickedFiles(e).isNotEmpty()
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val paths = pickedFiles(e)
        if (paths.isEmpty()) {
            Notify.show(project, Copy.ATTACH_NO_FILES)
            return
        }
        val flow = CommandFlow(project)
        val change = flow.pickChange(Copy.ATTACH_TITLE, Copy.ATTACH_WHICH_CHANGE) ?: return
        val argv = Commands.attachArgv(change, paths)
        flow.captured(argv) { r -> flow.said(argv, r) }
    }
}

/**
 * ADR 0113: a task's context where the code is written. Asks the change and the task, reads
 * atticus task context, and puts it on the clipboard for Copilot Chat in agent mode, with the
 * slash command that reads it itself: Copilot in IntelliJ gives plugins no way to open its chat.
 */
class StartTaskAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val flow = CommandFlow(project)
        val change = flow.pickChange(Copy.START_TASK_TITLE, Copy.START_TASK_WHICH_CHANGE) ?: return
        val task = flow.pickTask(change) ?: return
        flow.captured(Commands.taskContextArgv(change, task)) { r ->
            if (!r.ok) {
                Notify.show(project, Copy.couldNotReadTask(Copy.firstLine(r.lines, r.code)), NotificationType.WARNING, Notify.showOutput(project))
                return@captured
            }
            val slash = Commands.taskSlash(change, task)
            CopyPasteManager.getInstance().setContents(StringSelection(r.stdout))
            Notify.show(
                project,
                Copy.taskContextCopied(task, slash),
                NotificationType.INFORMATION,
                Notify.action(Copy.copy(slash)) { CopyPasteManager.getInstance().setContents(StringSelection(slash)) },
            ).also { it.setTitle(Copy.START_TASK_TITLE) }
        }
    }
}
