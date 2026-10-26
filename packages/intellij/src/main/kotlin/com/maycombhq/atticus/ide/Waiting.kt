package com.maycombhq.atticus.ide

import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import com.maycombhq.atticus.core.Commands
import com.maycombhq.atticus.core.Copy
import com.maycombhq.atticus.core.OpenQuestion
import com.maycombhq.atticus.core.Peer

/** IntelliJ's own ways to answer, watch and start (WP6): native, through the command line. */
class PeerFlows(private val project: Project) {
    private val flow = CommandFlow(project)

    /** Pick an open question, then answer it. */
    fun pickAndAnswer() {
        flow.captured(listOf("questions", "list", "--state", "open", "--json")) { r ->
            val qs = com.maycombhq.atticus.core.Waiting.questions(r.stdout)
            if (qs.isEmpty()) {
                Notify.show(project, if (r.ok) Copy.ANSWER_NONE else Copy.waitingCouldNotRead(Copy.firstLine(r.lines, r.code)))
                return@captured
            }
            val shown = qs.map { "${it.question}  —  ${it.repo}" }
            val d = PickDialog(project, Copy.ANSWER_TITLE, Copy.PICK_OR_TYPE, shown, typed = false)
            if (!d.showAndGet()) return@captured
            qs.getOrNull(shown.indexOf(d.value()))?.let { answer(it) }
        }
    }

    fun answer(q: OpenQuestion) {
        val d = AnswerDialog(project, q)
        if (!d.showAndGet()) return
        val argv = Peer.answerArgv(q.id, d.option(), d.text()) ?: return
        flow.captured(argv) { r ->
            Notify.show(
                project,
                if (r.ok) Copy.answered(r.lines.firstOrNull().orEmpty()) else Copy.firstLine(r.lines, r.code),
                if (r.ok) NotificationType.INFORMATION else NotificationType.WARNING,
                Notify.showOutput(project),
            )
            AtticusStatus.of(project).refresh()
        }
    }

    fun watch() {
        val change = flow.pickChange(Copy.WATCH_TITLE, Copy.WATCH_WHICH) ?: return
        val argv = listOf("watch", change)
        flow.captured(argv) { r ->
            flow.said(argv, r)
            AtticusStatus.of(project).refresh()
        }
    }

    /** A new change: its title, then an earlier change like it to start from (WP7.6), then change new. */
    fun newChange() {
        val title = com.intellij.openapi.ui.Messages.showInputDialog(project, Copy.NEW_CHANGE_ASK, Copy.NEW_CHANGE_TITLE, null)?.trim()
        if (title.isNullOrEmpty()) return
        flow.captured(listOf("change", "similar", title, "--json")) { r ->
            val past = Peer.pastChanges(r.stdout)
            var like: String? = null
            if (past.isNotEmpty()) {
                val shown = listOf(Copy.START_FROM_NOTHING) + past.map { "${it.title}  —  ${it.archived ?: it.id}" }
                val d = PickDialog(project, Copy.START_FROM_TITLE, Copy.START_FROM_HINT, shown, typed = false)
                if (!d.showAndGet()) return@captured
                like = past.getOrNull(shown.indexOf(d.value()) - 1)?.id
            }
            val cat = flow.catalog() ?: return@captured
            val cmd = cat.commands.firstOrNull { it.id == "change new" } ?: return@captured
            val a = flow.ask(cmd, listOf(listOf(title)), like?.let { mapOf("--like" to it) }.orEmpty()) ?: return@captured
            flow.run(cmd, Commands.buildArgv(cmd, a))
        }
    }
}
