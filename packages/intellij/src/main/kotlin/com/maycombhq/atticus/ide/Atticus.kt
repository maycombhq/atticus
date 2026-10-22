package com.maycombhq.atticus.ide

import com.intellij.execution.ExecutionException
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.CapturingProcessHandler
import com.intellij.notification.Notification
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.SystemInfo
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.util.EnvironmentUtil
import com.maycombhq.atticus.core.CommandLine
import com.maycombhq.atticus.core.Copy
import com.maycombhq.atticus.core.Launch
import com.maycombhq.atticus.core.Metarepo
import java.io.File
import java.nio.charset.StandardCharsets
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList

/** What one run of the command line gave. */
data class Ran(val code: Int, val stdout: String, val stderr: String) {
    val ok get() = code == 0
    val lines: List<String> get() = (stdout.trimEnd().lines() + stderr.trimEnd().lines()).filter { it.isNotBlank() }
}

/**
 * Running `atticus` (ADR 0099): the program and its arguments go to the process as they are, never
 * through a shell where it can be avoided. Every command run and what it printed go to the
 * Output tab of the Atticus tool window.
 */
object AtticusCli {
    private val machine: CommandLine
        get() {
            val path = EnvironmentUtil.getValue("PATH") ?: System.getenv("PATH") ?: ""
            val ext = (System.getenv("PATHEXT") ?: ".EXE;.CMD;.BAT").split(';').filter { it.isNotBlank() }
            return CommandLine(SystemInfo.isWindows, path.split(File.pathSeparatorChar).filter { it.isNotBlank() }, ext)
        }

    fun launch(cwd: String): Launch = machine.resolve(AtticusSettings.get().state.atticusPath ?: "", cwd)

    /** The process to start; fails when an argument can't be passed safely. */
    fun commandLine(cwd: String, args: List<String>): GeneralCommandLine {
        val l = launch(cwd)
        CommandLine.refusal(l, args)?.let { throw ExecutionException(it) }
        return GeneralCommandLine(l.argv(args))
            .withWorkDirectory(cwd)
            .withCharset(StandardCharsets.UTF_8)
            .withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE)
    }

    /** Run and wait; call it off the UI thread (in a background task or under a progress dialog). */
    fun run(project: Project, cwd: String, args: List<String>, timeoutMs: Int = 30 * 60 * 1000): Ran {
        val log = AtticusLog.of(project)
        log.line("> ${CommandLine.text(args)}")
        val ran =
            try {
                val h = CapturingProcessHandler(commandLine(cwd, args))
                val indicator = ProgressManager.getInstance().progressIndicator
                val out = if (indicator != null) h.runProcessWithProgressIndicator(indicator) else h.runProcess(timeoutMs)
                Ran(if (out.isCancelled) 130 else out.exitCode, out.stdout, out.stderr)
            } catch (e: ExecutionException) {
                Ran(127, "", "Couldn't start atticus: ${e.message}")
            }
        for (l in ran.lines) log.line(l)
        log.line("exit ${ran.code}")
        return ran
    }
}

/** The folder commands run in: the metarepo when the project is one, else the project. */
object Roots {
    fun base(project: Project): Path? = project.basePath?.let { Path.of(it) }

    fun metarepo(project: Project): Path? = base(project)?.takeIf { Metarepo.orgPack(it) != null }

    fun cwd(project: Project): String = (metarepo(project) ?: base(project))?.toString() ?: System.getProperty("user.home")
}

/** Every command run and what it printed, for the Output tab (like the VS Code extension's Atticus output). */
@Service(Service.Level.PROJECT)
class AtticusLog {
    private val text = StringBuilder()
    private val listeners = CopyOnWriteArrayList<(String) -> Unit>()

    fun line(s: String) {
        synchronized(text) {
            text.append(s).append('\n')
            if (text.length > 400_000) text.delete(0, text.length - 300_000)
        }
        for (l in listeners) l(s + "\n")
    }

    fun all(): String = synchronized(text) { text.toString() }

    fun listen(parent: Disposable, l: (String) -> Unit) {
        listeners += l
        Disposer.register(parent) { listeners -= l }
    }

    companion object {
        fun of(project: Project): AtticusLog = project.service()
    }
}

object Notify {
    private fun group() = NotificationGroupManager.getInstance().getNotificationGroup("Atticus")

    fun show(project: Project, content: String, type: NotificationType = NotificationType.INFORMATION, vararg actions: NotificationAction): Notification {
        val n = group().createNotification(content, type)
        for (a in actions) n.addAction(a)
        n.notify(project)
        return n
    }

    fun action(text: String, run: () -> Unit): NotificationAction = NotificationAction.createSimpleExpiring(text) { run() }

    fun showOutput(project: Project) = action(Copy.SHOW_OUTPUT) { AtticusWindow.showTab(project, Copy.OUTPUT_TAB) }
}

object AtticusWindow {
    const val ID = "Atticus"

    fun showTab(project: Project, tab: String) {
        val w = ToolWindowManager.getInstance(project).getToolWindow(ID) ?: return
        w.activate {
            w.contentManager.findContent(tab)?.let { w.contentManager.setSelectedContent(it) }
        }
    }
}
