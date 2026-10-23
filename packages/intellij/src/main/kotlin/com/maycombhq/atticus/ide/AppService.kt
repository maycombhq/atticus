package com.maycombhq.atticus.ide

import com.intellij.execution.ExecutionException
import com.intellij.execution.process.KillableProcessHandler
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessListener
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.Key
import com.maycombhq.atticus.core.Catalog
import com.maycombhq.atticus.core.CommandLine
import com.maycombhq.atticus.core.Commands
import com.maycombhq.atticus.core.Copy
import com.maycombhq.atticus.core.Metarepo
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList

/** Where the app is: what the tool window shows. */
sealed interface AppState {
    data object Checking : AppState

    data object CliMissing : AppState

    data object NoMetarepo : AppState

    data object Starting : AppState

    data class Running(val url: String) : AppState

    data class Stopped(val message: String) : AppState
}

/**
 * The Atticus app for this project (ADR 0099): `atticus ui --port 0 --root <metarepo>`, started
 * when the tool window first opens and stopped when the project closes. It listens on 127.0.0.1
 * only; the plugin reads the address it prints.
 */
@Service(Service.Level.PROJECT)
class AtticusApp(private val project: Project) : Disposable {
    @Volatile
    var state: AppState = AppState.Checking
        private set

    @Volatile
    private var handler: KillableProcessHandler? = null
    private val listeners = CopyOnWriteArrayList<(AppState) -> Unit>()
    private val reloads = CopyOnWriteArrayList<() -> Unit>()

    fun listen(parent: Disposable, onState: (AppState) -> Unit, onReload: () -> Unit) {
        listeners += onState
        reloads += onReload
        Disposer.register(parent) {
            listeners -= onState
            reloads -= onReload
        }
    }

    private fun set(s: AppState) {
        state = s
        ApplicationManager.getApplication().invokeLater({ for (l in listeners) l(s) }, project.disposed)
    }

    /** Check the command line, then start the app when the project is a metarepo. */
    fun refresh() {
        stop()
        set(AppState.Checking)
        ApplicationManager.getApplication().executeOnPooledThread {
            val v = AtticusCli.run(project, Roots.cwd(project), listOf("--version"), 60_000)
            when {
                !v.ok -> set(AppState.CliMissing)
                else -> Roots.metarepo(project)?.let { start(it) } ?: set(AppState.NoMetarepo)
            }
        }
    }

    /** Show the page again when the app is running; otherwise check again. */
    fun reload() {
        if (state is AppState.Running) {
            for (r in reloads) ApplicationManager.getApplication().invokeLater(r, project.disposed)
        } else {
            refresh()
        }
    }

    private fun start(root: Path) {
        set(AppState.Starting)
        // The catalogue says whether this command line can stop with the IDE (--parent).
        val catalog =
            runCatching { Catalog.parse(AtticusCli.run(project, root.toString(), listOf("commands", "--json"), 60_000).stdout) }.getOrNull()
        val args = Commands.uiArgs(root.toString(), catalog, ProcessHandle.current().pid())
        val log = AtticusLog.of(project)
        log.line("> ${CommandLine.text(args)}")
        val h =
            try {
                KillableProcessHandler(AtticusCli.commandLine(root.toString(), args))
            } catch (e: ExecutionException) {
                log.line("Couldn't start atticus: ${e.message}")
                set(AppState.Stopped("Couldn't start atticus: ${e.message}"))
                return
            }
        h.setShouldKillProcessSoftly(false)
        val printed = StringBuilder()
        h.addProcessListener(
            object : ProcessListener {
                override fun onTextAvailable(event: ProcessEvent, outputType: Key<*>) {
                    // The session token stays out of the log; the page has it.
                    val text = event.text.replace(Regex("(session token is )\\S+"), "$1(hidden)")
                    for (l in text.lines().filter { it.isNotBlank() }) log.line(l)
                    if (state is AppState.Starting) {
                        printed.append(event.text)
                        Metarepo.appUrl(printed.toString())?.let { set(AppState.Running(it)) }
                    }
                }

                override fun processTerminated(event: ProcessEvent) {
                    log.line("exit ${event.exitCode}")
                    if (handler === h) {
                        handler = null
                        set(AppState.Stopped(Copy.appStopped(event.exitCode)))
                    }
                }
            },
        )
        handler = h
        h.startNotify()
    }

    fun stop() {
        val h = handler
        handler = null
        if (h != null && !h.isProcessTerminated) h.destroyProcess()
    }

    override fun dispose() = stop()

    companion object {
        fun of(project: Project): AtticusApp = project.service()
    }
}
