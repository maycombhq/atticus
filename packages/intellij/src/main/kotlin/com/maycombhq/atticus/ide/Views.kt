package com.maycombhq.atticus.ide

import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.DoubleClickListener
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.treeStructure.Tree
import com.intellij.util.ui.tree.TreeUtil
import com.maycombhq.atticus.core.CallPathRow
import com.maycombhq.atticus.core.CallPaths
import com.maycombhq.atticus.core.ChangeRow
import com.maycombhq.atticus.core.Changes
import com.maycombhq.atticus.core.Commands
import com.maycombhq.atticus.core.Copy
import com.maycombhq.atticus.core.Filter
import com.maycombhq.atticus.core.FindingRow
import com.maycombhq.atticus.core.Findings
import com.maycombhq.atticus.core.Grouping
import com.maycombhq.atticus.core.HopRow
import com.maycombhq.atticus.core.History
import com.maycombhq.atticus.core.Lists
import com.maycombhq.atticus.core.Metarepo
import com.maycombhq.atticus.core.ModelRuns
import com.maycombhq.atticus.core.NeedRow
import com.maycombhq.atticus.core.Needs
import com.maycombhq.atticus.core.Next
import com.maycombhq.atticus.core.NextStep
import com.maycombhq.atticus.core.Pick
import com.maycombhq.atticus.core.PromptRow
import com.maycombhq.atticus.core.RepoRow
import com.maycombhq.atticus.core.Repos
import com.maycombhq.atticus.core.RunRow
import com.maycombhq.atticus.core.SourceRow
import com.maycombhq.atticus.core.Sources
import com.maycombhq.atticus.core.TaskKnowledge
import com.maycombhq.atticus.core.TaskKnowledgeRow
import com.maycombhq.atticus.core.WaitingItem
import com.maycombhq.atticus.core.WaitingRows
import com.maycombhq.atticus.core.Words
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseEvent
import java.util.concurrent.CopyOnWriteArrayList
import javax.swing.JTree
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel

/**
 * The tool window's native trees (ADR 0105 addendum 2): Next, Changes, Repos, Knowledge, Model
 * runs and Prompt history, beside Waiting on you, the app and the Output. Each reads the command
 * line in the background, shows a loading row while it reads, the reason when it can't and what
 * to do when there is nothing (the Definition of done's empty, loading and error states), and
 * each has a filter box where its list grows.
 *
 * What each row *is* and what it says are in core (Views.kt), tested without the IDE; this draws.
 */

/** A row of any Atticus tree: a heading, something with a label and a line beside it, or a note. */
sealed interface Row {
    val label: String
    val detail: String
    val words: List<String?>

    data class Heading(override val label: String) : Row {
        override val detail = ""
        override val words = emptyList<String?>()
    }

    /** A row that says what is going on: loading, empty or the reason a read failed. */
    data class Note(override val label: String) : Row {
        override val detail = ""
        override val words = emptyList<String?>()
    }

    data class Step(val step: NextStep) : Row {
        override val label get() = Words.stepTitle(step)
        override val detail get() = step.command
        override val words get() = listOf(step.command, step.why)
    }

    data class Repo(val repo: RepoRow) : Row {
        override val label get() = repo.id
        override val detail get() = repo.detail
        override val words get() = listOf(repo.id, repo.description)
    }

    data class Change(val change: ChangeRow) : Row {
        override val label get() = change.title
        override val detail get() = change.detail
        override val words get() = change.words
    }

    data class Task(val change: String, val task: Pick) : Row {
        override val label get() = task.label
        override val detail get() = "${task.value} · ${task.detail}"
        override val words get() = listOf(task.value, task.label, change)
    }

    data class Source(val source: SourceRow) : Row {
        override val label get() = source.id
        override val detail get() = source.detail
        override val words get() = listOf(source.id, source.type, source.owner)
    }

    data class Knowledge(val item: Pick) : Row {
        override val label get() = item.label
        override val detail get() = item.detail
        override val words get() = listOf(item.value, item.label, item.detail)
    }

    data class TaskKnowledgePage(val page: TaskKnowledgeRow) : Row {
        override val label get() = page.title
        override val detail get() = page.detail
        override val words get() = listOf(page.id, page.title, page.page)
    }

    data class Question(val question: com.maycombhq.atticus.core.OpenQuestion) : Row {
        override val label get() = question.question
        override val detail get() = question.repo
        override val words get() = listOf(question.id, question.question, question.repo)
    }

    data class Manual(val step: Pick) : Row {
        override val label get() = step.label
        override val detail get() = step.detail
        override val words get() = listOf(step.value, step.label, step.detail)
    }

    data class Need(val need: NeedRow) : Row {
        override val label get() = need.title
        override val detail get() = need.detail
        override val words get() = need.words
    }

    data class Finding(val finding: FindingRow) : Row {
        override val label get() = finding.summary
        override val detail get() = finding.detail
        override val words get() = finding.words
    }

    data class Run(val run: RunRow) : Row {
        override val label get() = run.agent
        override val detail get() = run.detail
        override val words get() = run.words
    }

    data class Prompt(val turn: PromptRow) : Row {
        override val label get() = turn.label
        override val detail get() = turn.detail
        override val words get() = turn.words
    }

    data class CallPath(val call: CallPathRow) : Row {
        override val label get() = call.label
        override val detail get() = call.detail
        override val words get() = listOf(call.fromRepo, call.toRepo, call.path)
    }

    data class Hop(val hop: HopRow) : Row {
        override val label get() = hop.route
        override val detail get() = hop.detail
        override val words get() = listOf(hop.route, hop.auth) + hop.scopes
    }
}

/**
 * The row the person last picked in any Atticus tree, so an action in the Tools menu or on a
 * toolbar acts on it (VS Code puts these on a row's own menu; IntelliJ actions read the selection).
 */
@Service(Service.Level.PROJECT)
class Selected {
    @Volatile
    var row: Row? = null

    companion object {
        fun of(project: Project): Selected = project.service()
    }
}

/** The tool window's trees, so Refresh reads every one of them again. */
@Service(Service.Level.PROJECT)
class AtticusTrees {
    private val trees = CopyOnWriteArrayList<RowTree>()

    fun register(all: List<RowTree>) {
        trees.clear()
        trees.addAll(all)
    }

    fun refreshAll() {
        for (t in trees) t.refresh()
    }

    companion object {
        fun of(project: Project): AtticusTrees = project.service()
    }
}

/** Where each tree keeps its filter, so Filter… and Clear filter reach it from the Tools menu. */
@Service(Service.Level.PROJECT)
class Filters {
    private val byTab = HashMap<String, String>()
    private val listeners = CopyOnWriteArrayList<(String) -> Unit>()

    fun get(tab: String): String = byTab[tab].orEmpty()

    fun set(tab: String, filter: String) {
        byTab[tab] = filter
        for (l in listeners) l(tab)
    }

    fun listen(l: (String) -> Unit) {
        listeners += l
    }

    companion object {
        fun of(project: Project): Filters = project.service()
    }
}

/**
 * A tree of rows that reads in the background and filters what it shows. Subclasses say what to
 * read ([read]) and what a double-click opens ([open]).
 */
abstract class RowTree(
    protected val project: Project,
    private val tab: String,
    private val reading: String,
    private val empty: String,
    private val toolbarActions: List<String>,
    parent: Disposable,
) : SimpleToolWindowPanel(true, true) {
    private val root = DefaultMutableTreeNode()
    private val model = DefaultTreeModel(root)
    private var rows: List<Row> = emptyList()

    protected val tree: Tree =
        Tree(model).apply {
            isRootVisible = false
            showsRootHandles = true
            emptyText.text = reading
            cellRenderer =
                object : ColoredTreeCellRenderer() {
                    override fun customizeCellRenderer(tree: JTree, value: Any?, selected: Boolean, expanded: Boolean, leaf: Boolean, row: Int, hasFocus: Boolean) {
                        when (val r = (value as? DefaultMutableTreeNode)?.userObject as? Row) {
                            is Row.Heading -> append(r.label, SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
                            is Row.Note -> append(r.label, SimpleTextAttributes.GRAYED_ATTRIBUTES)
                            null -> Unit
                            else -> {
                                append(r.label)
                                if (r.detail.isNotEmpty()) append("  ${r.detail}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                            }
                        }
                    }
                }
        }

    init {
        val group = DefaultActionGroup()
        for (id in toolbarActions) ActionManager.getInstance().getAction(id)?.let { group.add(it) }
        val bar = ActionManager.getInstance().createActionToolbar("Atticus$tab", group, true)
        bar.targetComponent = this
        toolbar = bar.component
        setContent(JBScrollPane(tree))
        object : DoubleClickListener() {
            override fun onDoubleClick(event: MouseEvent): Boolean = opened()
        }.installOn(tree)
        tree.addKeyListener(
            object : KeyAdapter() {
                override fun keyPressed(e: KeyEvent) {
                    if (e.keyCode == KeyEvent.VK_ENTER && opened()) e.consume()
                }
            },
        )
        tree.addTreeSelectionListener { Selected.of(project).row = picked() }
        Filters.of(project).listen { changed -> if (changed == tab) ApplicationManager.getApplication().invokeLater { draw() } }
    }

    protected fun picked(): Row? = (tree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? Row

    private fun opened(): Boolean {
        val r = picked() ?: return false
        if (r is Row.Heading || r is Row.Note) return false
        open(r)
        return true
    }

    /** What to read, off the UI thread. A note row is what a read that failed hands back. */
    protected abstract fun read(): List<Row>

    protected abstract fun open(row: Row)

    /** Rows under a row, read when it is opened; none by default. */
    protected open fun children(row: Row): List<Row> = emptyList()

    fun refresh() {
        tree.emptyText.text = reading
        ProgressManager.getInstance().run(
            object : Task.Backgroundable(project, "Atticus: ${reading.trimEnd('…')}", true) {
                private var got: List<Row> = emptyList()

                override fun run(indicator: ProgressIndicator) {
                    got = runCatching { read() }.getOrElse { listOf(Row.Note(Copy.couldNotRun(it.message ?: ""))) }
                }

                override fun onSuccess() {
                    rows = got
                    draw()
                }
            },
        )
    }

    private fun draw() {
        val filter = Filters.of(project).get(tab)
        val shown = rows.filter { it is Row.Heading || it is Row.Note || Filter.matches(filter, it.words + it.label + it.detail) }
        root.removeAllChildren()
        tree.emptyText.text =
            when {
                filter.isNotEmpty() && shown.none { it !is Row.Heading && it !is Row.Note } -> Copy.nothingMatched(filter)
                else -> empty
            }
        var under: DefaultMutableTreeNode? = null
        for (r in shown) {
            val node = DefaultMutableTreeNode(r)
            if (r is Row.Heading) {
                root.add(node)
                under = node
            } else {
                (under ?: root).add(node)
                for (c in children(r)) node.add(DefaultMutableTreeNode(c))
            }
        }
        model.reload()
        TreeUtil.expandAll(tree)
        revalidate()
        repaint()
    }
}

// ------------------------------------------------------------------ the tabs

/**
 * What waits on you (WP6.2, ADR 0105 addendum): the questions to answer here, each change's open
 * needs, open findings and manual steps, and the knowledge no one has checked. Grouped by change
 * by default, by kind when the person asks, and filtered by the box in the toolbar.
 */
class WaitingPanel(project: Project, parent: Disposable) :
    RowTree(
        project,
        Copy.WAITING_TAB,
        Copy.WAITING_READING,
        Copy.WAITING_NOTHING,
        listOf(
            "Atticus.Refresh",
            "Atticus.AnswerQuestion",
            "Atticus.WaitingByChange",
            "Atticus.WaitingByKind",
            "Atticus.FilterWaiting",
            "Atticus.ClearFilterWaiting",
            "Atticus.NeedDone",
            "Atticus.NeedSkip",
            "Atticus.FindingAction",
        ),
        parent,
    ) {
    private val cli = Reads(project)

    init {
        tree.toolTipText = Copy.WAITING_HINT
    }

    override fun read(): List<Row> {
        if (cli.metarepo == null) return listOf(Row.Note(Copy.NO_METAREPO_TITLE))
        val waiting = com.maycombhq.atticus.core.Waiting.parse(cli.json(listOf("waiting"))) ?: return listOf(Row.Note(Copy.NO_METAREPO_TITLE))
        val titles = Changes.rows(cli.json(listOf("change", "list"))).associate { it.id to it.title }
        val items =
            buildList<WaitingItem> {
                addAll(waiting.questions.map { WaitingItem.Question(it) })
                addAll(cli.needs().map { WaitingItem.Need(it) })
                for (c in waiting.changes.filter { it.openFindings > 0 }) addAll(cli.findings(c.id).map { WaitingItem.Finding(it) })
                addAll(Lists.todos(cli.json(listOf("todo", "--all"))).map { WaitingItem.Manual(it, it.detail.split(" · ").firstOrNull()?.takeIf { d -> d in titles }) })
                if (waiting.knowledgeToVerify > 0) add(WaitingItem.Knowledge(waiting.knowledgeToVerify))
            }
        if (items.isEmpty()) return listOf(Row.Note(Copy.WAITING_NOTHING))
        val by = if (AtticusSettings.get().state.waitingByKind) Grouping.BY_KIND else Grouping.BY_CHANGE
        return WaitingRows.groups(items, by) { c -> titles[c] ?: c }.flatMap { (title, these) ->
            listOf(Row.Heading(title)) + these.map { rowOf(it) }
        }
    }

    private fun rowOf(i: WaitingItem): Row =
        when (i) {
            is WaitingItem.Question -> Row.Question(i.question)
            is WaitingItem.Need -> Row.Need(i.need)
            is WaitingItem.Finding -> Row.Finding(i.finding)
            is WaitingItem.Manual -> Row.Manual(i.step)
            is WaitingItem.Knowledge -> Row.Note(Copy.waitingKnowledge(i.count))
        }

    override fun open(row: Row) {
        when (row) {
            is Row.Question -> PeerFlows(project).answer(row.question)
            is Row.Need -> openScreen(project, Commands.cockpitHash(row.need.change))
            is Row.Finding -> openScreen(project, Commands.cockpitHash(row.finding.change))
            is Row.Manual -> openScreen(project, "#/todo")
            else -> Unit
        }
    }
}

/** What is next: the next step and the setup checklist, each row with Run the step. */
class NextPanel(project: Project, parent: Disposable) :
    RowTree(project, Copy.NEXT_TAB, Copy.CHECKING, Copy.NO_NEXT, listOf("Atticus.Refresh", "Atticus.RunStep", "Atticus.NextStep"), parent) {
    private val cli = Reads(project)

    override fun read(): List<Row> {
        val view = Next.parse(cli.json(listOf("next"))) ?: return listOf(Row.Note(Copy.NO_NEXT))
        val steps = listOfNotNull(view.next) + view.steps.filter { it !== view.next }
        if (steps.isEmpty()) return listOf(Row.Note(Copy.NO_NEXT))
        return listOf(Row.Heading(Copy.NEXT_TAB)) + steps.map { Row.Step(it) }
    }

    override fun open(row: Row) {
        if (row is Row.Step) StepFlows(project).take(row.step)
    }
}

/** My changes: each with its state, its work, its risk and the kinds of test it needs. */
class ChangesPanel(project: Project, parent: Disposable) :
    RowTree(
        project,
        Copy.CHANGES_TAB,
        Copy.CHANGES_READING,
        Copy.NO_CHANGES,
        listOf("Atticus.Refresh", "Atticus.NewChange", "Atticus.FilterChanges", "Atticus.ClearFilterChanges", "Atticus.StartTask"),
        parent,
    ) {
    private val cli = Reads(project)

    override fun read(): List<Row> {
        val rows = Changes.rows(cli.json(listOf("change", "list")))
        if (rows.isEmpty()) return listOf(Row.Note(Copy.NO_CHANGES))
        // A store's change has no status of its own (ADR 0126: read-only).
        val full = rows.map { if (it.store == null) Changes.withStatus(it, cli.json(listOf("change", "status", it.id))) else it }
        val stores = Changes.storeLines(cli.text(listOf("openspec", "check")))
        return listOf(Row.Heading(Copy.CHANGES_TAB)) + full.map { Row.Change(it) } +
            (if (stores.isEmpty()) emptyList() else listOf(Row.Heading(Copy.OPENSPEC_ARTIFACTS)) + stores.map { Row.Note(it) })
    }

    /** A change opens to its tasks, and a task to the knowledge pages that apply to it. */
    override fun children(row: Row): List<Row> =
        when {
            row is Row.Change && row.change.store == null ->
                Reads(project).metarepo?.let { Lists.tasks(it, row.change.id) }.orEmpty().map { Row.Task(row.change.id, it) }
            else -> emptyList()
        }

    override fun open(row: Row) {
        when (row) {
            is Row.Change -> openScreen(project, Commands.cockpitHash(row.change.id))
            is Row.Task -> TaskFlows(project).showKnowledge(row.change, row.task.value)
            else -> Unit
        }
    }
}

/** The repos of the manifests, each with what a person says it is (ADR 0128). */
class ReposPanel(project: Project, parent: Disposable) :
    RowTree(
        project,
        Copy.REPOS_TAB,
        Copy.REPOS_READING,
        Copy.REPOS_NONE,
        listOf("Atticus.Refresh", "Atticus.AddRepos", "Atticus.DescribeRepo", "Atticus.OnboardRepo", "Atticus.ReadRepo", "Atticus.EstateJoin"),
        parent,
    ) {
    private val cli = Reads(project)

    override fun read(): List<Row> {
        val orgPack = cli.metarepo?.let { Metarepo.orgPack(it) } ?: return listOf(Row.Note(Copy.NO_METAREPO_TITLE))
        val rows = Repos.merged(Repos.rows(orgPack), Repos.described(cli.json(listOf("repo", "describe"))))
        if (rows.isEmpty()) return listOf(Row.Note(Copy.REPOS_NONE))
        // ADR 0124 addendum A-gateway2: the calls that go through gateways, with auth and scopes.
        val calls = CallPaths.rows(cli.json(listOf("estate", "join"))).filter { it.hops.isNotEmpty() }
        return listOf(Row.Heading(Copy.REPOS_TAB)) + rows.map { Row.Repo(it) } +
            listOf(Row.Heading(Copy.CALL_PATHS)) +
            (if (calls.isEmpty()) listOf(Row.Note(Copy.CALL_PATHS_NONE)) else calls.map { Row.CallPath(it) })
    }

    override fun children(row: Row): List<Row> = if (row is Row.CallPath) row.call.hops.map { Row.Hop(it) } else emptyList()

    override fun open(row: Row) {
        when (row) {
            is Row.Repo -> openScreen(project, "#/systems")
            is Row.CallPath -> openScreen(project, Commands.impactHash(row.call.toRepo))
            else -> Unit
        }
    }
}

/** What the organisation knows: the items no one has checked first (ADR 0101, 0105). */
class KnowledgePanel(project: Project, parent: Disposable) :
    RowTree(
        project,
        Copy.KNOWLEDGE_TAB,
        Copy.CHECKING,
        Copy.NO_KNOWLEDGE,
        listOf(
            "Atticus.Refresh",
            "Atticus.AddKnowledge",
            "Atticus.SyncSources",
            "Atticus.KnowledgeScan",
            "Atticus.FilterKnowledge",
            "Atticus.ClearFilterKnowledge",
            "Atticus.VerifyItem",
            "Atticus.CorrectItem",
            "Atticus.RejectItem",
        ),
        parent,
    ) {
    private val cli = Reads(project)

    override fun read(): List<Row> {
        val sources = cli.metarepo?.let { Metarepo.orgPack(it) }?.let { Sources.rows(it) }.orEmpty()
        val items = Lists.knowledgeItems(cli.json(listOf("knowledge", "list")))
        if (sources.isEmpty() && items.isEmpty()) return listOf(Row.Note(Copy.NO_KNOWLEDGE))
        val (unchecked, checked) = items.partition { !it.detail.endsWith("verified") }
        return buildList {
            if (sources.isNotEmpty()) {
                add(Row.Heading(Copy.KNOWLEDGE_SOURCES))
                addAll(sources.map { Row.Source(it) })
            }
            if (unchecked.isNotEmpty()) {
                add(Row.Heading(Copy.KNOWLEDGE_TO_CHECK))
                addAll(unchecked.map { Row.Knowledge(it) })
            }
            if (checked.isNotEmpty()) {
                add(Row.Heading(Copy.KNOWLEDGE_CHECKED))
                addAll(checked.map { Row.Knowledge(it) })
            }
        }
    }

    override fun open(row: Row) {
        when (row) {
            is Row.Knowledge -> openScreen(project, "#/knowledge")
            is Row.Source -> openScreen(project, "#/wikis")
            else -> Unit
        }
    }
}

/** What Atticus asked a model and what came back (ADR 0106). */
class RunsPanel(project: Project, parent: Disposable) :
    RowTree(
        project,
        Copy.RUNS_TAB,
        Copy.RUNS_READING,
        Copy.RUNS_NONE,
        listOf("Atticus.Refresh", "Atticus.FilterRuns", "Atticus.ClearFilterRuns", "Atticus.ModelRuns"),
        parent,
    ) {
    private val cli = Reads(project)

    override fun read(): List<Row> {
        val rows = ModelRuns.rows(cli.json(listOf("runs")))
        return if (rows.isEmpty()) listOf(Row.Note(Copy.RUNS_NONE)) else listOf(Row.Heading(Copy.RUNS_TAB)) + rows.map { Row.Run(it) }
    }

    override fun open(row: Row) {
        if (row is Row.Run) openScreen(project, ModelRuns.hash(row.run.runId))
    }
}

/**
 * What people asked their assistant here and what it answered (ADR 0110). Copilot's chats in
 * IntelliJ can't be recorded, and the empty row says so rather than leaving it unsaid.
 */
class HistoryPanel(project: Project, parent: Disposable) :
    RowTree(project, Copy.HISTORY_TAB, Copy.HISTORY_READING, Copy.HISTORY_NONE, listOf("Atticus.Refresh", "Atticus.PromptHistory"), parent) {
    private val cli = Reads(project)

    override fun read(): List<Row> {
        val json = cli.json(listOf("history"))
        val rows = History.rows(json)
        val head = if (History.recording(json)) Copy.HISTORY_TAB else Copy.HISTORY_OFF
        return if (rows.isEmpty()) listOf(Row.Note(Copy.HISTORY_NONE)) else listOf(Row.Heading(head)) + rows.map { Row.Prompt(it) }
    }

    override fun open(row: Row) {
        if (row is Row.Prompt) openScreen(project, Metarepo.PROMPT_HISTORY_SCREEN)
    }
}

/** Reading the command line for a tree: on the calling thread, so a tree reads in the background. */
class Reads(private val project: Project) {
    private val cwd = Roots.cwd(project)
    val metarepo = Roots.metarepo(project)

    fun json(argv: List<String>): String = AtticusCli.run(project, cwd, Commands.withRoot(argv + "--json", cwd)).stdout

    fun text(argv: List<String>): String = AtticusCli.run(project, cwd, Commands.withRoot(argv, cwd)).let { it.stdout + "\n" + it.stderr }

    /** Needs and findings for the Waiting tree, which reads them per change. */
    fun needs(): List<NeedRow> = Needs.open(Needs.rows(json(listOf("needs", "--all"))))

    fun findings(change: String): List<FindingRow> = Findings.rows(change, json(listOf("findings", change)))
}
