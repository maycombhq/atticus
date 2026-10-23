package com.maycombhq.atticus.ide

import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.openapi.project.Project
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAwareAction
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

/** What Atticus asked a model and what came back (#/runs). */
class ModelRunsAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        openScreen(e.project ?: return, "#/runs")
    }
}
