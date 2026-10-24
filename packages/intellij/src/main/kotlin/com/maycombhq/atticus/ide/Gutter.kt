package com.maycombhq.atticus.ide

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.markup.GutterIconRenderer
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.VirtualFile
import com.maycombhq.atticus.core.CiteLine
import com.maycombhq.atticus.core.Cites
import com.maycombhq.atticus.core.Commands
import com.maycombhq.atticus.core.Copy
import com.maycombhq.atticus.core.Peer
import javax.swing.Icon

/**
 * What passes through a line of code, in the gutter (WP7.3 in IntelliJ): a mark on each line a
 * spec flow or a catalog record cites, saying the flows, the changes in flight on them and the
 * records; a click opens the flow, a change, or what breaks if it changes. Read from
 * `atticus cites --file` when a file of the metarepo's workspace opens.
 */
class AtticusGutter : FileEditorManagerListener {
    override fun fileOpened(source: FileEditorManager, file: VirtualFile) {
        val project = source.project
        val root = Roots.metarepo(project) ?: return
        if (!file.isInLocalFileSystem || file.isDirectory) return
        val path = file.toNioPath()
        if (!path.startsWith(root)) return
        val cwd = root.toString()
        ApplicationManager.getApplication().executeOnPooledThread {
            val r = AtticusCli.run(project, cwd, listOf("cites", "--file", path.toString(), "--json", "--root", cwd), 60_000)
            val lines = if (r.ok) Cites.parse(r.stdout) else emptyList()
            if (lines.isEmpty()) return@executeOnPooledThread
            ApplicationManager.getApplication().invokeLater({ mark(source, file, lines) }, project.disposed)
        }
    }

    private fun mark(source: FileEditorManager, file: VirtualFile, lines: List<CiteLine>) {
        for (e in source.getEditors(file).filterIsInstance<TextEditor>()) {
            val editor = e.editor
            val markup = editor.markupModel
            editor.getUserData(MARKS)?.forEach { markup.removeHighlighter(it) }
            val doc = editor.document
            val added =
                lines.filter { it.line in 1..doc.lineCount }.map { l ->
                    markup.addLineHighlighter(l.line - 1, HighlighterLayer.ADDITIONAL_SYNTAX, null).apply {
                        gutterIconRenderer = CiteMark(source.project, l)
                    }
                }
            editor.putUserData(MARKS, added)
        }
    }

    companion object {
        private val MARKS = Key.create<List<RangeHighlighter>>("atticus.cites")
    }
}

private class CiteMark(private val project: com.intellij.openapi.project.Project, private val line: CiteLine) : GutterIconRenderer() {
    override fun getIcon(): Icon = if (line.changes.isNotEmpty()) AllIcons.General.Warning else AllIcons.Nodes.Related

    override fun getTooltipText(): String = Peer.citeTip(line)

    override fun isNavigateAction() = true

    override fun getPopupMenuActions(): DefaultActionGroup = actions()

    override fun getClickAction(): AnAction =
        object : DumbAwareAction() {
            override fun actionPerformed(e: AnActionEvent) {
                val group = actions()
                com.intellij.openapi.ui.popup.JBPopupFactory.getInstance()
                    .createActionGroupPopup(null, group, e.dataContext, com.intellij.openapi.ui.popup.JBPopupFactory.ActionSelectionAid.SPEEDSEARCH, true)
                    .showInBestPositionFor(e.dataContext)
            }
        }

    private fun actions(): DefaultActionGroup {
        val g = DefaultActionGroup()
        for (f in line.flows) g.add(open("${Copy.GUTTER_OPEN_FLOW}: ${f.name}", Commands.flowHash(f.repo, f.flow, f.step)))
        for (c in line.changes) g.add(open(Copy.gutterOpenChange(c), Commands.cockpitHash(c)))
        line.flows.firstOrNull()?.let { g.add(open(Copy.GUTTER_IMPACT, Commands.impactHash(it.flow))) }
        return g
    }

    private fun open(text: String, hash: String): AnAction =
        object : DumbAwareAction(text) {
            override fun actionPerformed(e: AnActionEvent) = openScreen(project, hash)
        }

    override fun equals(other: Any?) = other is CiteMark && other.line == line

    override fun hashCode() = line.hashCode()
}
