package com.maycombhq.atticus.ide

import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager
import com.maycombhq.atticus.core.Commands
import com.maycombhq.atticus.core.Copy
import com.maycombhq.atticus.core.FindingRow
import com.maycombhq.atticus.core.Findings
import com.maycombhq.atticus.core.Handoff
import com.maycombhq.atticus.core.NeedRow
import com.maycombhq.atticus.core.Next
import com.maycombhq.atticus.core.NextAction
import com.maycombhq.atticus.core.NextStep
import com.maycombhq.atticus.core.Steps
import com.maycombhq.atticus.core.StepTarget
import com.maycombhq.atticus.core.TaskKnowledge
import com.maycombhq.atticus.core.Words
import java.awt.datatransfer.StringSelection

/**
 * The actions that do one named job each (ADR 0105 addendum 2): an AI step handed to Copilot
 * Chat or Claude Code, a command Atticus runs itself, or something done to the row the person
 * picked in a tree. What each one runs is in core (Steps, Views); nothing is decided here.
 *
 * One base class per shape, then one line per action, so every job is its own entry in the Tools
 * menu and in Find Action, as the VS Code command palette lists its own.
 */

/** A step of [Steps]: its target asked for, then run as its kind needs. */
abstract class StepAction(private val stepId: String) : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val step = Steps.of(stepId) ?: return
        StepFlows(project).run(step, extra(e))
    }

    /** Options an action adds to the command (a row's id, say). */
    protected open fun extra(e: AnActionEvent): List<String> = emptyList()
}

// ---------------------------------------------------------------- the AI steps

class ReadRepoAction : StepAction("Atticus.ReadRepo")

class SurveyAction : StepAction("Atticus.Survey")

class ScanVerifyAction : StepAction("Atticus.ScanVerify")

class DraftSpecAction : StepAction("Atticus.DraftSpec")

class FeatureAction : StepAction("Atticus.Feature")

class ArchitectureAction : StepAction("Atticus.Architecture")

class StoriesAction : StepAction("Atticus.Stories")

class SmallChangeAction : StepAction("Atticus.SmallChange")

class CriticAction : StepAction("Atticus.Critic")

class KnowledgeScanAction : StepAction("Atticus.KnowledgeScan")

class AskKnowledgeAction : StepAction("Atticus.AskKnowledge")

class FindNeedsAction : StepAction("Atticus.FindNeeds")

// ---------------------------------------------------------------- the commands Atticus runs

class VerifyFactsAction : StepAction("Atticus.VerifyFacts")

class DescribeRepoAction : StepAction("Atticus.DescribeRepo")

class AskCatalogAction : StepAction("Atticus.AskCatalog")

class ScanAllAction : StepAction("Atticus.ScanAll")

class EstateJoinAction : StepAction("Atticus.EstateJoin")

class WorkspaceSyncAction : StepAction("Atticus.WorkspaceSync")

class SyncSourcesAction : StepAction("Atticus.SyncSources")

class UpgradeAction : StepAction("Atticus.Upgrade")

class CheckHealthAction : StepAction("Atticus.CheckHealth")

class DigestAction : StepAction("Atticus.Digest")

class AddReposAction : StepAction("Atticus.AddRepos")

class BringInAction : StepAction("Atticus.BringIn")

class AcceptBroughtInAction : StepAction("Atticus.AcceptBroughtIn")

class OnboardRepoAction : StepAction("Atticus.OnboardRepo")

class AddWikiAction : StepAction("Atticus.AddWiki")

class AcceptCatalogAction : StepAction("Atticus.AcceptCatalog")

class DraftOrgPackAction : StepAction("Atticus.DraftOrgPack")

class OrgPackOwnerAction : StepAction("Atticus.OrgPackOwner")

class RunTaskAction : StepAction("Atticus.RunTask")

// ---------------------------------------------------------------- on the row that is picked

/** A step on the row the person picked in a tree; [of] says what it takes from the row. */
abstract class RowStepAction(private val stepId: String) : AtticusAction() {
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.project?.let { Selected.of(it).row }?.let { takes(it) != null } == true
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val row = Selected.of(project).row
        val extra = row?.let { takes(it) }
        if (extra == null) {
            Notify.show(project, Copy.NOTHING_SELECTED)
            return
        }
        val step = Steps.of(stepId) ?: return
        StepFlows(project).run(step, extra, askTarget = false)
    }

    /** What the row gives the command, or null when the row isn't one this acts on. */
    protected abstract fun takes(row: Row): List<String>?
}

/** A knowledge item reviewed, from its row (ADR 0101). */
abstract class KnowledgeItemAction(stepId: String) : RowStepAction(stepId) {
    override fun takes(row: Row): List<String>? = (row as? Row.Knowledge)?.let { listOf(it.item.value) }
}

class VerifyItemAction : KnowledgeItemAction("Atticus.VerifyItem")

class CorrectItemAction : KnowledgeItemAction("Atticus.CorrectItem")

class RejectItemAction : KnowledgeItemAction("Atticus.RejectItem")

/** A question about the item picked, asked of the knowledge (an AI step). */
class AskAboutItemAction : RowStepAction("Atticus.AskAboutItem") {
    override fun takes(row: Row): List<String>? = (row as? Row.Knowledge)?.let { listOf(it.item.label) }
}

/**
 * One wiki or docs source, from its row in the Knowledge tab: synced, read into knowledge or
 * tagged. `sources tag` takes the source as its argument; the other two take `--source`.
 */
abstract class SourceAction(stepId: String, private val asFlag: Boolean) : RowStepAction(stepId) {
    override fun takes(row: Row): List<String>? =
        (row as? Row.Source)?.source?.id?.let { if (asFlag) listOf("--source", it) else listOf(it) }
}

class SyncSourceAction : SourceAction("Atticus.SyncSource", asFlag = true)

class TagSourceAction : SourceAction("Atticus.TagSource", asFlag = false)

/** One source read into knowledge (an AI step on that source). */
class ReadSourceAction : SourceAction("Atticus.ReadSource", asFlag = true)

/** A need marked, from its row (ADR 0101): `needs done|skip|reopen <change> <item>`. */
abstract class NeedAction(stepId: String) : RowStepAction(stepId) {
    override fun takes(row: Row): List<String>? = (row as? Row.Need)?.need?.let { listOf(it.change, it.item) }
}

class NeedDoneAction : NeedAction("Atticus.NeedDone")

class NeedReopenAction : NeedAction("Atticus.NeedReopen")

/** Not needed: the note that says why goes with it. */
class NeedSkipAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val need = (Selected.of(project).row as? Row.Need)?.need
        if (need == null) {
            Notify.show(project, Copy.NOTHING_SELECTED)
            return
        }
        val note = Messages.showInputDialog(project, Copy.NEED_NOTE, Copy.NEED_NOT_NEEDED, null)?.trim()
        if (note.isNullOrEmpty()) return
        val argv = listOf("needs", "skip", need.change, need.item, "--note", note)
        val flow = CommandFlow(project)
        flow.captured(argv) { r ->
            flow.said(argv, r)
            AtticusStatus.of(project).refresh()
        }
    }
}

/** A manual step shown, from its row or by its id (`atticus todo show <step>`). */
class ShowManualStepAction : StepAction("Atticus.ShowManualStep")

// ---------------------------------------------------------------- the rest

/** Knowledge in, the three ways: bring in a repo, add a wiki or docs repo, or add files. */
class AddKnowledgeAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val choices = listOf(Copy.ADD_KNOWLEDGE_BRING_IN, Copy.ADD_KNOWLEDGE_WIKI, Copy.ADD_KNOWLEDGE_FILES)
        val i = Messages.showDialog(project, Copy.ADD_KNOWLEDGE_HOW, Copy.ADD_KNOWLEDGE_TITLE, (choices + Copy.CANCEL).toTypedArray(), 0, null)
        val step =
            when (i) {
                0 -> Steps.of("Atticus.BringIn")
                1 -> Steps.of("Atticus.AddWiki")
                2 -> {
                    Notify.show(project, Copy.ATTACH_NO_FILES)
                    null
                }
                else -> null
            }
        step?.let { StepFlows(project).run(it, emptyList()) }
    }
}

/** The step the person picked in the Next tab, or the next one when none is picked. */
class RunStepAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val step = (Selected.of(project).row as? Row.Step)?.step
        if (step == null) NextFlow(project).show() else StepFlows(project).take(step)
    }
}

/** Act on the finding the person picked (ADR 0094): the critic's own actions, nothing else. */
class FindingActionAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val f = (Selected.of(project).row as? Row.Finding)?.finding
        if (f == null) {
            Notify.show(project, Copy.NOTHING_SELECTED)
            return
        }
        act(project, f)
    }

    private fun act(project: com.intellij.openapi.project.Project, f: FindingRow) {
        val choices = Findings.actions(f)
        val i = Messages.showDialog(project, Copy.FINDING_WHICH_ACTION, f.summary, (choices.map { it.label } + Copy.CANCEL).toTypedArray(), 0, null)
        val chosen = choices.getOrNull(i) ?: return
        val given =
            when (chosen.needs) {
                "reason" -> Messages.showInputDialog(project, Copy.FINDING_REASON, Copy.FINDING_ACTION_TITLE, null)?.trim() ?: return
                "asked-of" -> Messages.showInputDialog(project, Copy.FINDING_ASKED_OF, Copy.FINDING_ACTION_TITLE, null)?.trim() ?: return
                else -> null
            }
        if (chosen.needs != null && given.isNullOrEmpty()) return
        val argv = Findings.argv(f, chosen, given)
        val flow = CommandFlow(project)
        flow.captured(argv) { r ->
            flow.said(argv, r)
            AtticusStatus.of(project).refresh()
        }
    }
}

/** A change's open needs, one after another, to mark (ADR 0101). */
class RaiseNeedsAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val picked = Selected.of(project).row
        val change =
            when (picked) {
                is Row.Need -> picked.need.change
                is Row.Change -> picked.change.id
                else -> CommandFlow(project).pickChange(Copy.RAISE_NEEDS_TITLE, Copy.WHICH_CHANGE)
            } ?: return
        openScreen(project, Commands.cockpitHash(change))
        Notify.show(project, Copy.raiseNeeds(change))
    }
}

// ---------------------------------------------------------------- the trees' own actions

/** Filter… and Clear filter on one tab's tree (ADR 0105 addendum). */
abstract class FilterAction(private val tab: String, private val clear: Boolean) : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        if (clear) {
            Filters.of(project).set(tab, "")
            return
        }
        val now = Filters.of(project).get(tab)
        val v = Messages.showInputDialog(project, Copy.FILTER_HINT, "${Copy.FILTER} $tab", null, now, null) ?: return
        Filters.of(project).set(tab, v.trim())
        AtticusWindow.showTab(project, tab)
    }
}

class FilterWaitingAction : FilterAction(Copy.WAITING_TAB, false)

class ClearFilterWaitingAction : FilterAction(Copy.WAITING_TAB, true)

class FilterChangesAction : FilterAction(Copy.CHANGES_TAB, false)

class ClearFilterChangesAction : FilterAction(Copy.CHANGES_TAB, true)

class FilterKnowledgeAction : FilterAction(Copy.KNOWLEDGE_TAB, false)

class ClearFilterKnowledgeAction : FilterAction(Copy.KNOWLEDGE_TAB, true)

class FilterRunsAction : FilterAction(Copy.RUNS_TAB, false)

class ClearFilterRunsAction : FilterAction(Copy.RUNS_TAB, true)

/** How the Waiting tree groups what waits (ADR 0105 addendum, 2026-10-23). */
abstract class GroupingAction(private val by: com.maycombhq.atticus.core.Grouping) : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        AtticusSettings.get().state.waitingByKind = by == com.maycombhq.atticus.core.Grouping.BY_KIND
        AtticusStatus.of(project).refresh()
        AtticusWindow.showTab(project, Copy.WAITING_TAB)
    }
}

class WaitingByChangeAction : GroupingAction(com.maycombhq.atticus.core.Grouping.BY_CHANGE)

class WaitingByKindAction : GroupingAction(com.maycombhq.atticus.core.Grouping.BY_KIND)

// ---------------------------------------------------------------- running a step

/**
 * Running one step (ADR 0121 addendum 2): an AI step goes to Copilot Chat or Claude Code, and a
 * command runs as its kind needs, with whatever it still asks for asked as Run a Command asks it.
 */
class StepFlows(private val project: com.intellij.openapi.project.Project) {
    private val flow = CommandFlow(project)

    fun run(step: com.maycombhq.atticus.core.NativeStep, extra: List<String>, askTarget: Boolean = true) {
        val title = Copy.stepTitle(step.words)
        val target =
            when {
                !askTarget -> null
                step.target == StepTarget.REPO -> flow.pickRepo(title, Copy.WHICH_REPO) ?: return
                step.target == StepTarget.CHANGE -> flow.pickChange(title, Copy.WHICH_CHANGE) ?: return
                else -> null
            }
        // What the row gave the command: its positionals first, then its options.
        val given = extra.takeWhile { !it.startsWith("-") }
        val options = Commands.optionPairs(extra.drop(given.size))
        if (step.ai) {
            flow.aiStep(step.argv(target) + given + options.flatMap { (k, v) -> listOfNotNull(k, v) }, step.slash(target))
            return
        }
        // The rest: the catalogue's own command, so its options are asked and its kind is honoured
        // (an AI step's slash command, a shared write's dry run and yes, a server's console).
        val cat = flow.catalog() ?: return
        val cmd = cat.commands.firstOrNull { it.words == step.words }
        if (cmd == null) {
            val argv = step.argv(target) + extra
            flow.captured(argv) { flow.said(argv, it) }
            return
        }
        val presets = (listOfNotNull(target) + given).map { listOf(it) }
        val a = flow.ask(cmd, presets, options) ?: return
        flow.run(cmd, Commands.buildArgv(cmd, a))
    }

    /** A step `atticus next` names, taken the way its kind needs. */
    fun take(step: NextStep) {
        when (val action = Next.actionFor(step)) {
            is NextAction.Ai -> flow.aiStep(action.args, action.slash)
            is NextAction.Answer -> PeerFlows(project).pickAndAnswer()
            is NextAction.Run -> {
                val cat = flow.catalog()
                val cmd = cat?.let { Commands.matchCommand(it, step.command)?.first }
                flow.run(cmd, action.args)
            }
            is NextAction.Person -> {
                Notify.show(project, "${Copy.PERSON_STEP} ${step.why}", NotificationType.INFORMATION, Notify.action(Copy.copy("the command")) {
                    CopyPasteManager.getInstance().setContents(StringSelection(step.command))
                })
            }
        }
    }
}

/** A task's knowledge pages (B-task-knowledge), in a notice beside the task's row. */
class TaskFlows(private val project: com.intellij.openapi.project.Project) {
    fun showKnowledge(change: String, task: String) {
        val flow = CommandFlow(project)
        flow.captured(listOf("task", "context", change, task, "--json")) { r ->
            val pages = TaskKnowledge.rows(r.stdout)
            if (pages.isEmpty()) {
                Notify.show(project, Copy.noTaskKnowledge(task), NotificationType.INFORMATION, Notify.showOutput(project))
                return@captured
            }
            val text =
                buildString {
                    append(Copy.TASK_KNOWLEDGE).append(":<br>")
                    for (p in pages.take(8)) {
                        append("• ").append(p.title).append(" — ").append(p.detail).append("<br>")
                        p.conflictQuestion?.let { append("  ").append(Copy.conflictAsked(it)).append("<br>") }
                    }
                }
            Notify.show(project, text, NotificationType.INFORMATION, Notify.action(Copy.OPEN_APP) { openScreen(project, "#/knowledge") })
                .also { it.setTitle(Copy.taskKnowledgeTitle(task)) }
        }
    }
}

/** Where a notice about the whole hand-off says which assistant it is for. */
internal fun handoffWays(modelMode: Boolean) = Handoff.ways(modelMode)
