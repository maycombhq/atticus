package com.maycombhq.atticus.ide

import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.DoubleClickListener
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.treeStructure.Tree
import com.intellij.util.ui.tree.TreeUtil
import com.maycombhq.atticus.core.Commands
import com.maycombhq.atticus.core.Copy
import com.maycombhq.atticus.core.OpenQuestion
import com.maycombhq.atticus.core.Peer
import com.maycombhq.atticus.core.WaitingChange
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseEvent
import javax.swing.JTree
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel

/** A row of the Waiting tree: a heading, a question, a change, or the knowledge no one has checked. */
private sealed interface Row {
    data class Heading(val text: String) : Row

    data class Question(val q: OpenQuestion) : Row

    data class Change(val c: WaitingChange) : Row

    data class Knowledge(val n: Int) : Row
}

/**
 * What waits on you, as a tree beside the app (WP6.2): the questions to answer here, each change
 * with something open, and the knowledge no one has checked. Read in the background and again
 * when the metarepo's files change.
 */
class WaitingPanel(private val project: Project, parent: Disposable) : SimpleToolWindowPanel(true, true) {
    private val root = DefaultMutableTreeNode()
    private val model = DefaultTreeModel(root)
    private val tree =
        Tree(model).apply {
            isRootVisible = false
            showsRootHandles = true
            emptyText.text = Copy.WAITING_READING
            cellRenderer =
                object : ColoredTreeCellRenderer() {
                    override fun customizeCellRenderer(tree: JTree, value: Any?, selected: Boolean, expanded: Boolean, leaf: Boolean, row: Int, hasFocus: Boolean) {
                        when (val r = (value as? DefaultMutableTreeNode)?.userObject as? Row) {
                            is Row.Heading -> append(r.text, SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
                            is Row.Question -> {
                                append(r.q.question)
                                append("  ${r.q.repo}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                            }
                            is Row.Change -> {
                                append(r.c.title)
                                append("  ${Peer.changeLine(r.c)}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                            }
                            is Row.Knowledge -> append(Copy.waitingKnowledge(r.n))
                            null -> Unit
                        }
                    }
                }
            toolTipText = Copy.WAITING_HINT
        }

    init {
        val group = DefaultActionGroup()
        for (id in listOf("Atticus.Refresh", "Atticus.AnswerQuestion", "Atticus.NextStep")) ActionManager.getInstance().getAction(id)?.let { group.add(it) }
        val bar = ActionManager.getInstance().createActionToolbar("AtticusWaiting", group, true)
        bar.targetComponent = this
        toolbar = bar.component
        setContent(JBScrollPane(tree))
        object : DoubleClickListener() {
            override fun onDoubleClick(event: MouseEvent): Boolean = open()
        }.installOn(tree)
        tree.addKeyListener(
            object : KeyAdapter() {
                override fun keyPressed(e: KeyEvent) {
                    if (e.keyCode == KeyEvent.VK_ENTER && open()) e.consume()
                }
            },
        )
        AtticusStatus.of(project).listen(parent) { show(it) }
    }

    private fun show(s: Snapshot) {
        root.removeAllChildren()
        val w = s.waiting
        when {
            !s.cliOk -> tree.emptyText.text = Copy.CLI_MISSING_TITLE
            w == null -> tree.emptyText.text = s.problem?.let { Copy.waitingCouldNotRead(it) } ?: Copy.NO_METAREPO_TITLE
            else -> {
                tree.emptyText.text = Copy.WAITING_NOTHING
                if (w.questions.isNotEmpty()) {
                    val h = DefaultMutableTreeNode(Row.Heading("${Copy.WAITING_QUESTIONS} (${w.questions.size})"))
                    for (q in w.questions) h.add(DefaultMutableTreeNode(Row.Question(q)))
                    root.add(h)
                }
                if (w.changes.isNotEmpty()) {
                    val h = DefaultMutableTreeNode(Row.Heading("${Copy.WAITING_CHANGES} (${w.changes.size})"))
                    for (c in w.changes) h.add(DefaultMutableTreeNode(Row.Change(c)))
                    root.add(h)
                }
                if (w.knowledgeToVerify > 0) root.add(DefaultMutableTreeNode(Row.Knowledge(w.knowledgeToVerify)))
            }
        }
        model.reload()
        TreeUtil.expandAll(tree)
    }

    private fun open(): Boolean {
        val r = (tree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? Row ?: return false
        when (r) {
            is Row.Question -> PeerFlows(project).answer(r.q)
            is Row.Change -> openScreen(project, Commands.cockpitHash(r.c.id))
            is Row.Knowledge -> openScreen(project, "#/knowledge")
            is Row.Heading -> return false
        }
        return true
    }
}

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
