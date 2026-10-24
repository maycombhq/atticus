package com.maycombhq.atticus.ide

import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.util.Alarm
import com.maycombhq.atticus.core.Commands
import com.maycombhq.atticus.core.Copy
import com.maycombhq.atticus.core.Next
import com.maycombhq.atticus.core.NextView
import com.maycombhq.atticus.core.Peer
import com.maycombhq.atticus.core.Waiting
import com.maycombhq.atticus.core.WaitingView
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

/** What the plugin last read (WP6): the next step, what waits on people, and the changes watched. */
data class Snapshot(
    val cliOk: Boolean,
    val next: NextView?,
    val waiting: WaitingView?,
    val watched: List<String>,
    val problem: String? = null,
)

/**
 * What waits on you and what comes next, read in the background from the command line, for the
 * status bar and the Waiting tree (WP6.2). Read again when the metarepo's files change.
 */
@Service(Service.Level.PROJECT)
class AtticusStatus(private val project: Project) : Disposable {
    @Volatile
    var snapshot: Snapshot? = null
        private set

    private val listeners = CopyOnWriteArrayList<(Snapshot) -> Unit>()
    private val reading = AtomicBoolean(false)
    private val again = AtomicBoolean(false)
    private val alarm = Alarm(Alarm.ThreadToUse.POOLED_THREAD, this)

    fun listen(parent: Disposable, l: (Snapshot) -> Unit) {
        listeners += l
        Disposer.register(parent) { listeners -= l }
        snapshot?.let(l)
    }

    /** Read again in a moment: many file events become one read. */
    fun soon() {
        alarm.cancelAllRequests()
        alarm.addRequest({ refresh() }, 1500)
    }

    /** Read now, off the UI thread; a read asked for while one runs runs after it. */
    fun refresh() {
        if (!reading.compareAndSet(false, true)) {
            again.set(true)
            return
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val s = read()
                snapshot = s
                ApplicationManager.getApplication().invokeLater({ for (l in listeners) l(s) }, project.disposed)
            } finally {
                reading.set(false)
                if (again.getAndSet(false)) refresh()
            }
        }
    }

    private fun read(): Snapshot {
        val cwd = Roots.cwd(project)
        if (Roots.metarepo(project) == null) return Snapshot(cliOk = true, next = null, waiting = null, watched = emptyList())
        val next = AtticusCli.run(project, cwd, listOf("next", "--json", "--root", cwd))
        if (next.code == 127) return Snapshot(cliOk = false, next = null, waiting = null, watched = emptyList(), problem = next.stderr)
        val waiting = AtticusCli.run(project, cwd, Commands.withRoot(listOf("waiting", "--json"), cwd))
        val watch = AtticusCli.run(project, cwd, Commands.withRoot(listOf("watch", "--json"), cwd))
        val w = Waiting.parse(waiting.stdout)
        return Snapshot(
            cliOk = true,
            next = Next.parse(next.stdout),
            waiting = w,
            watched = if (watch.ok) Peer.watchLines(watch.stdout) else emptyList(),
            problem = if (w == null) Copy.firstLine(waiting.lines, waiting.code) else null,
        )
    }

    override fun dispose() = Unit

    companion object {
        fun of(project: Project): AtticusStatus = project.service()
    }
}

/** The metarepo's own files: a change to one means what waits may have changed. */
class AtticusFileListener : BulkFileListener {
    private val watched = Regex("[/\\\\](specs|catalog|openspec|questions|knowledge|org-pack|inputs)[/\\\\]|[/\\\\]\\.atticus[/\\\\]me\\.yaml$")

    override fun after(events: List<VFileEvent>) {
        if (events.none { watched.containsMatchIn(it.path) }) return
        for (p in ProjectManager.getInstance().openProjects) {
            val root = Roots.metarepo(p)?.toString()?.replace('\\', '/') ?: continue
            if (events.any { it.path.replace('\\', '/').startsWith(root) }) AtticusStatus.of(p).soon()
        }
    }
}

/**
 * When a project opens (WP6.2): read what waits, and say once, with a way not to be told again,
 * when the command line can't be found.
 */
class AtticusStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        val status = AtticusStatus.of(project)
        status.listen(status) { s ->
            if (!s.cliOk && !AtticusSettings.get().state.hideCliMissing && !shown.getAndSet(true)) {
                Notify.show(
                    project,
                    Copy.CLI_MISSING,
                    NotificationType.WARNING,
                    Notify.action(Copy.SET_PATH) { com.intellij.openapi.options.ShowSettingsUtil.getInstance().showSettingsDialog(project, AtticusConfigurable::class.java) },
                    Notify.action(Copy.DONT_SHOW_AGAIN) { AtticusSettings.get().state.hideCliMissing = true },
                ).also { it.setTitle(Copy.CLI_MISSING_TITLE) }
            }
        }
        status.refresh()
    }

    private val shown = AtomicBoolean(false)
}
