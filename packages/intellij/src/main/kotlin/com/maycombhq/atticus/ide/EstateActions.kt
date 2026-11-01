package com.maycombhq.atticus.ide

import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.maycombhq.atticus.core.AgentHandoff
import com.maycombhq.atticus.core.Agents
import com.maycombhq.atticus.core.Commands
import com.maycombhq.atticus.core.Copy
import com.maycombhq.atticus.core.Next
import com.maycombhq.atticus.core.NextStep
import com.maycombhq.atticus.core.OpenQuestion
import com.maycombhq.atticus.core.Peer
import com.maycombhq.atticus.core.Steps
import java.awt.datatransfer.StringSelection
import java.nio.file.Path

/**
 * What 2.0.0-beta.10 added to the command line, as actions of their own (ADR 0159): each in
 * Tools → Atticus and in Find Action, run in the background with its output in the Output tab, as
 * the actions of ADR 0105 addendum 2 are. Where the job ends in Copilot Chat (the second pass on
 * the gaps, the assistant's proposed answers), its slash command goes on the clipboard, as the AI
 * steps' do. What each runs is in core (Steps.ESTATE, Commands, Peer); nothing is decided here.
 */

// ---------------------------------------------------------------- run as they stand

class EstateFreshAction : StepAction("Atticus.EstateFresh")

class ReadingQueueAction : StepAction("Atticus.ReadingQueue")

class JoinMeasureAction : StepAction("Atticus.JoinMeasure")

class AuditReportAction : StepAction("Atticus.AuditReport")

class ChangeImpactAction : StepAction("Atticus.ChangeImpact")

class SeedSpecAction : StepAction("Atticus.SeedSpec")

class ApplySheetAction : StepAction("Atticus.ApplySheet")

class CheckProposalsAction : StepAction("Atticus.CheckProposals")

// ---------------------------------------------------------------- the ones that ask or open more

/** ADR 0157: plan the second pass on the gaps, then `/atticus-map <repo> --gaps` on the clipboard. */
class MapGapsAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val step = Steps.of("Atticus.MapGaps") ?: return
        val flow = CommandFlow(project)
        val repo = flow.pickRepo(Copy.stepTitle(step.argv(null)), Copy.WHICH_REPO) ?: return
        val argv = step.argv(repo)
        flow.captured(argv) { r ->
            if (!r.ok) return@captured flow.said(argv, r)
            val prompt = Roots.metarepo(project)?.let { Commands.gapsPrompt(it, repo) }
            val open = prompt?.let { p -> Notify.action(Copy.OPEN_GAPS) { flow.open(p) } }
            val slash = Commands.gapsSlash(repo)
            flow.slashOnClipboard(slash, Copy.done("map --gaps", Copy.firstLine(r.lines, r.code)) + "<br>" + Copy.gapsCopied(slash), *listOfNotNull(open).toTypedArray())
        }
    }
}

/** ADR 0144: `/atticus-propose` on the clipboard: the assistant proposes an answer to each open question. */
class ProposeAnswersAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val flow = CommandFlow(project)
        val check = Notify.action(Copy.CHECK_PROPOSALS) { Steps.of("Atticus.CheckProposals")?.let { StepFlows(project).run(it, emptyList()) } }
        flow.slashOnClipboard(Steps.PROPOSE_SLASH, Copy.proposeCopied(Steps.PROPOSE_SLASH), check)
    }
}

/** ADR 0153: every open question in one sheet, written and opened in the editor. */
class QuestionsSheetAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val flow = CommandFlow(project)
        val argv = Steps.of("Atticus.QuestionsSheet")?.argv(null) ?: return
        flow.captured(argv) { r ->
            flow.said(argv, r)
            if (r.ok) flow.open(Path.of(Roots.cwd(project)).resolve(Copy.SHEET_FILE))
        }
    }
}

/** ADR 0146: a repo's starting spec, accepted once a person has read it. */
class AcceptSeedAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val repo = CommandFlow(project).pickRepo(Copy.SEED_TITLE, Copy.WHICH_REPO) ?: return
        EstateFlows(project).acceptSeed(repo, null)
    }
}

/** ADR 0151: a gateway or API catalogue export, kept only as counts. */
class IntakeTrafficAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val flow = CommandFlow(project)
        val title = Copy.stepTitle(listOf("intake", "traffic"))
        val file = flow.pickFile(title, Copy.TRAFFIC_PICK) ?: return
        val source = flow.pickOne(title, Copy.TRAFFIC_SOURCE, Commands.TRAFFIC_SOURCES) ?: return
        val argv = Commands.trafficArgv(file, source)
        flow.captured(argv) { flow.said(argv, it) }
    }
}

/** F5: a repo's id moved, with what is filed under it, after the person says yes. */
class RenameRepoAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val picked = (Selected.of(project).row as? Row.Repo)?.repo?.id
        val old = picked ?: CommandFlow(project).pickRepo(Copy.RENAME_TITLE, Copy.RENAME_WHICH) ?: return
        val new = CommandFlow(project).typedValue(Copy.RENAME_TITLE, Copy.RENAME_TO, old) ?: return
        EstateFlows(project).rename(old, new)
    }
}

/** ADR 0144: the question picked, answered with the assistant's checked proposal, as the person. */
class AcceptProposalAction : AtticusAction() {
    override fun update(e: AnActionEvent) {
        val project = e.project
        e.presentation.isEnabled = project != null && EstateFlows.proposalQuestion(Selected.of(project).row) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val q = EstateFlows.proposalQuestion(Selected.of(project).row)
        if (q == null) {
            Notify.show(project, Copy.NO_PROPOSAL)
            return
        }
        EstateFlows(project).answered(Peer.acceptArgv(q.id))
    }
}

/** ADR 0140: Waiting on you lists only the questions for the person's teams, remembered. */
class WaitingMineAction : ToggleAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun isSelected(e: AnActionEvent): Boolean = AtticusSettings.get().state.waitingMine

    override fun setSelected(e: AnActionEvent, state: Boolean) {
        AtticusSettings.get().state.waitingMine = state
        val project = e.project ?: return
        AtticusTrees.of(project).refreshAll()
        AtticusWindow.showTab(project, Copy.WAITING_TAB)
    }
}

/** ADR 0121 addendum: the next step for Copilot's agent mode, its custom agent named. */
class RunInCopilotAgentAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val picked = (Selected.of(project).row as? Row.Step)?.step
        if (picked != null) return EstateFlows(project).toAgent(picked)
        CommandFlow(project).captured(listOf("next", "--json")) { r ->
            val n = Next.parse(r.stdout)?.next
            if (n == null) Notify.show(project, Copy.AGENT_NO_STEP) else EstateFlows(project).toAgent(n)
        }
    }
}

/** The flows the actions above and the Next and Waiting tabs share. */
class EstateFlows(private val project: Project) {
    private val flow = CommandFlow(project)

    /** ADR 0146, 0156: read the seed, then accept it; a change that collided writes its stories again. */
    fun acceptSeed(repo: String, change: String?) {
        val seed = Roots.metarepo(project)?.let { Commands.seedChange(it, repo) }
        val where = seed?.let { Path.of(Roots.cwd(project)).relativize(it).toString().replace('\\', '/') }
        val buttons = listOfNotNull(Copy.ACCEPT_SEED, if (seed != null) Copy.OPEN_SEED else null, Copy.CANCEL)
        val i = Messages.showDialog(project, Copy.seedConfirm(repo, where), Copy.SEED_TITLE, buttons.toTypedArray(), if (seed != null) 1 else 0, Messages.getQuestionIcon())
        when (buttons.getOrNull(i)) {
            Copy.OPEN_SEED -> seed?.let { flow.open(it) }
            Copy.ACCEPT_SEED -> {
                val argv = Steps.of("Atticus.AcceptSeed")?.argv(repo) ?: return
                flow.captured(argv) { r ->
                    if (!r.ok || change == null) return@captured flow.said(argv, r)
                    Notify.show(
                        project,
                        Copy.done("spec accept", Copy.firstLine(r.lines, r.code)) + "<br>" + Copy.seedThenStories(change),
                        NotificationType.INFORMATION,
                        Notify.action(Copy.WRITE_STORIES_AGAIN) { Steps.of("Atticus.Stories")?.let { s -> flow.aiStep(s.argv(change), s.slash(change)) } },
                        Notify.showOutput(project),
                    )
                    AtticusStatus.of(project).refresh()
                }
            }
            else -> Unit
        }
    }

    /** F5: `atticus repo rename <old> <new>`, after the person says yes; nothing is committed or pushed. */
    fun rename(old: String, new: String) {
        val argv = Commands.renameArgv(old, new)
        if (argv == null) {
            Notify.show(project, Copy.RENAME_TO, NotificationType.WARNING)
            return
        }
        val yes = Messages.showOkCancelDialog(project, Copy.renameConfirm(old, new.trim()), Copy.RENAME_TITLE, Copy.RENAME, Copy.CANCEL, Messages.getQuestionIcon())
        if (yes != Messages.OK) return
        flow.captured(argv) { r ->
            flow.said(argv, r)
            AtticusTrees.of(project).refreshAll()
        }
    }

    /** An answer written by the command line, then what waits read again. */
    fun answered(argv: List<String>) {
        flow.captured(argv) { r ->
            Notify.show(
                project,
                if (r.ok) Copy.answered(r.lines.firstOrNull().orEmpty()) else Copy.firstLine(r.lines, r.code),
                if (r.ok) NotificationType.INFORMATION else NotificationType.WARNING,
                Notify.showOutput(project),
            )
            AtticusStatus.of(project).refresh()
            AtticusTrees.of(project).refreshAll()
        }
    }

    /** A step for Copilot's agent mode: its agent named, its prompt on the clipboard; else its slash command. */
    fun toAgent(step: NextStep) {
        when (val h = Agents.handoff(Roots.metarepo(project), step.command)) {
            is AgentHandoff.Agent -> {
                com.intellij.openapi.ide.CopyPasteManager.getInstance().setContents(StringSelection(h.query))
                val chat = Copilot.chatAction()
                Notify.show(
                    project,
                    Copy.agentCopied(h.agent, h.stepClass, h.isPrompt) + "<br>" + (if (chat != null) Copy.COPILOT_API else Copy.COPILOT_NO_API),
                    NotificationType.INFORMATION,
                    *listOfNotNull(
                        if (chat != null) Notify.action(Copy.OPEN_COPILOT_CHAT) { Copilot.openChat() } else null,
                        Notify.action(Copy.copy(if (h.isPrompt) Copy.THE_PROMPT else h.query)) {
                            com.intellij.openapi.ide.CopyPasteManager.getInstance().setContents(StringSelection(h.query))
                        },
                    ).toTypedArray(),
                ).also { it.setTitle(Copy.AI_TITLE) }
            }
            is AgentHandoff.Chat -> {
                Notify.show(project, h.why, NotificationType.INFORMATION)
                StepFlows(project).take(step)
            }
        }
    }

    companion object {
        /** The question a row stands for, when it has a checked proposal to accept. */
        fun proposalQuestion(row: Row?): OpenQuestion? =
            when (row) {
                is Row.Question -> row.question
                is Row.Proposed -> row.question
                else -> null
            }?.takeIf { it.proposal != null }
    }
}
