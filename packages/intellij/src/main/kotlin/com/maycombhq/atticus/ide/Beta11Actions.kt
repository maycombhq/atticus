package com.maycombhq.atticus.ide

import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.panel
import com.intellij.util.ui.JBUI
import com.maycombhq.atticus.core.Beta11
import com.maycombhq.atticus.core.CommandLine
import com.maycombhq.atticus.core.Copy
import com.maycombhq.atticus.core.Metarepo
import com.maycombhq.atticus.core.OpenQuestion
import com.maycombhq.atticus.core.TargetPlan
import java.awt.Dimension
import java.awt.Font
import java.awt.datatransfer.StringSelection
import javax.swing.Action
import javax.swing.JComponent

/**
 * What 2.0.0-beta.11 added, as the plugin's own actions and dialogs (ADR 0166). Every write runs
 * the command line only after the person's click, with the command shown first; nothing here
 * decides what is written. What each runs is in core (Beta11, Copy).
 */

/** The "Another repo…" picker (ADR 0162): any repo, system or team, a new system asked first. */
class TargetFlow(private val project: Project) {
    private val flow = CommandFlow(project)

    fun answer(q: OpenQuestion, match: String?) {
        flow.captured(Beta11.showArgv(q.id)) { r ->
            if (!r.ok) {
                Notify.show(project, Copy.picksFailed(Copy.firstLine(r.lines, r.code)), NotificationType.WARNING, Notify.showOutput(project))
                return@captured
            }
            val all = Beta11.picks(r.stdout)
            if (all == null) {
                Notify.show(project, Copy.PICKS_OLD, NotificationType.WARNING)
                return@captured
            }
            val picks = Beta11.shown(all, q.step)
            val lines = picks.map(Beta11::line)
            val d = PickDialog(project, Copy.PICK_TARGET_TITLE, if (q.step == Beta11.TOPICS_STEP) Copy.PICK_OWNER else Copy.PICK_TARGET, lines, typed = true)
            if (!d.showAndGet()) return@captured
            val plan = Beta11.plan(all, Beta11.targetOf(d.value() ?: return@captured)) ?: return@captured
            val argv =
                when (plan) {
                    is TargetPlan.Answer -> Beta11.targetArgv(q.id, plan.target, match = match)
                    is TargetPlan.Offer -> {
                        // The new system is written only on the person's yes, the command shown.
                        val buttons = if (plan.vendor) arrayOf(Copy.ADD_AS_VENDOR, Copy.ADD_AS_INTERNAL, Copy.CANCEL) else arrayOf(Copy.ADD_AS_INTERNAL, Copy.CANCEL)
                        val shown = CommandLine.text(Beta11.targetArgv(q.id, plan.target, if (plan.vendor) "vendor" else "internal", match))
                        val i = Messages.showDialog(project, Copy.addSystemAsk(plan, shown), Copy.ADD_SYSTEM_TITLE, buttons, 0, Messages.getQuestionIcon())
                        when (buttons.getOrNull(i)) {
                            Copy.ADD_AS_VENDOR -> Beta11.targetArgv(q.id, plan.target, "vendor", match)
                            Copy.ADD_AS_INTERNAL -> Beta11.targetArgv(q.id, plan.target, "internal", match)
                            else -> return@captured
                        }
                    }
                }
            EstateFlows(project).answered(argv)
        }
    }
}

/** ADR 0164 (F7): `atticus join contracts`, its counts said, Map › Mismatches a click away. */
class ContractMismatchesAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val flow = CommandFlow(project)
        flow.captured(Beta11.CONTRACTS_ARGV + "--json") { r ->
            val words = if (r.ok) Beta11.contractsWords(Beta11.contractCounts(r.stdout)) else null
            Notify.show(
                project,
                words ?: Copy.firstLine(r.lines, r.code),
                if (words != null) NotificationType.INFORMATION else NotificationType.WARNING,
                Notify.action(Copy.OPEN_MISMATCHES) {
                    AtticusApp.of(project).open(Beta11.MISMATCHES_SCREEN)
                    AtticusWindow.showTab(project, Copy.APP_TAB)
                },
                // The whole check in words, read-only.
                Notify.action(Copy.SHOW_CHECK) { flow.captured(Beta11.CONTRACTS_ARGV) { t -> TextDialog(project, Copy.CONTRACTS_TITLE, null, t.lines.joinToString("\n")).show() } },
            ).also { it.setTitle(Copy.CONTRACTS_TITLE) }
            AtticusStatus.of(project).refresh()
        }
    }
}

/** The repo type picked, or null (org-wide); [cancelled] when the person stopped. */
private class TypePick(val type: String?, val cancelled: Boolean)

private fun pickType(project: Project, title: String): TypePick {
    val types = Beta11.repoTypes(Roots.metarepo(project)?.let { Metarepo.orgPack(it) })
    val shown = listOf(Copy.ORG_WIDE_NOTES) + types
    val v = CommandFlow(project).pickOne(title, Copy.NOTES_WHICH, shown) ?: return TypePick(null, true)
    return TypePick(v.takeIf { it != Copy.ORG_WIDE_NOTES }, false)
}

/** ADR 0163 (F9): a repo type's notes, or the org-wide ones, read-only. */
class RepoTypeNotesAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val t = pickType(project, Copy.NOTES_TITLE)
        if (t.cancelled) return
        val argv = Beta11.noteArgv(t.type)
        CommandFlow(project).captured(argv) { r -> TextDialog(project, Copy.NOTES_TITLE, CommandLine.text(argv), r.lines.joinToString("\n")).show() }
    }
}

/** ADR 0163 (F9): a note added, in the person's words, only after their yes with the command shown. */
class AddNoteAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val t = pickType(project, Copy.ADD_NOTE_TITLE)
        if (t.cancelled) return
        val typed = CommandFlow(project).typedValue(Copy.ADD_NOTE_TITLE, Copy.NOTE_ASK) ?: return
        val note = Beta11.noteOf(typed)
        if (note == null) {
            Notify.show(project, Copy.NOTE_BAD, NotificationType.WARNING)
            return
        }
        val argv = Beta11.noteArgv(t.type, note)
        val yes = Messages.showOkCancelDialog(project, Copy.noteConfirm(t.type, CommandLine.text(argv)), Copy.ADD_NOTE_TITLE, Copy.ADD_NOTE, Copy.CANCEL, Messages.getQuestionIcon())
        if (yes != Messages.OK) return
        val flow = CommandFlow(project)
        flow.captured(argv) { flow.said(argv, it) }
    }
}

/** ADR 0163 (F9): the rule drafts the notes make, read-only; Save the drafts is a click and a yes. */
class DraftRulesAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        CommandFlow(project).captured(Beta11.RULES_ARGV) { r ->
            val d = TextDialog(project, Copy.RULES_TITLE, CommandLine.text(Beta11.RULES_ARGV), r.lines.joinToString("\n"), more = Copy.SAVE_RULES)
            if (d.showAndGet() && d.moreAsked) saveRules(project)
        }
    }
}

/** ADR 0163 (F9): `atticus repo-type rules --save`, after the person's yes. */
class SaveRulesAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        saveRules(e.project ?: return)
    }
}

private fun saveRules(project: Project) {
    val argv = Beta11.RULES_SAVE_ARGV
    val yes = Messages.showOkCancelDialog(project, Copy.rulesSaveConfirm(CommandLine.text(argv)), Copy.SAVE_RULES_TITLE, Copy.SAVE, Copy.CANCEL, Messages.getQuestionIcon())
    if (yes != Messages.OK) return
    val flow = CommandFlow(project)
    flow.captured(argv) { flow.said(argv, it) }
}

/** F10: `atticus doctor --counts` in a panel to read and copy: counts and flags only, safe to paste. */
class DoctorCountsAction : AtticusAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        CommandFlow(project).captured(Beta11.COUNTS_ARGV) { r -> TextDialog(project, Copy.COUNTS_TITLE, Copy.COUNTS_HINT, r.lines.joinToString("\n")).show() }
    }
}

/**
 * What a command printed, read-only and selectable, with Copy (all of it to the clipboard) and,
 * when [more] is given, a button for the job that follows (Save the drafts), only on a click.
 */
class TextDialog(project: Project, dialogTitle: String, private val hint: String?, private val text: String, private val more: String? = null) : DialogWrapper(project) {
    private val area =
        JBTextArea(text).apply {
            isEditable = false
            font = Font(Font.MONOSPACED, Font.PLAIN, font.size)
            caretPosition = 0
        }

    /** Whether the person asked for [more]. */
    var moreAsked = false
        private set

    init {
        title = dialogTitle
        setOKButtonText(Copy.CLOSE)
        init()
    }

    override fun createCenterPanel(): JComponent =
        panel {
            hint?.let { row { comment(com.intellij.openapi.util.text.StringUtil.escapeXmlEntities(it)) } }
            row { cell(JBScrollPane(area).apply { preferredSize = Dimension(JBUI.scale(720), JBUI.scale(380)) }).align(AlignX.FILL) }
        }

    override fun getPreferredFocusedComponent(): JComponent = area

    override fun createLeftSideActions(): Array<Action> {
        val copy =
            object : DialogWrapperAction(Copy.COPY_ALL) {
                override fun doAction(e: java.awt.event.ActionEvent?) {
                    CopyPasteManager.getInstance().setContents(StringSelection(text))
                    setErrorText(null)
                    putValue(NAME, Copy.COPIED)
                }
            }
        val next =
            more?.let {
                object : DialogWrapperAction(it) {
                    override fun doAction(e: java.awt.event.ActionEvent?) {
                        moreAsked = true
                        close(OK_EXIT_CODE)
                    }
                }
            }
        return listOfNotNull(copy, next).toTypedArray()
    }

    override fun createActions(): Array<Action> = arrayOf(okAction)
}
