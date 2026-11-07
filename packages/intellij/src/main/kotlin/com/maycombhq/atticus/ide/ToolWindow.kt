package com.maycombhq.atticus.ide

import com.maycombhq.atticus.core.Metarepo
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.AnimatedIcon
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.dsl.builder.panel
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.util.ui.JBUI
import com.maycombhq.atticus.core.Copy
import com.maycombhq.atticus.core.Words
import java.awt.BorderLayout
import java.awt.Font
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingConstants

/** The Atticus tool window: the app, or what to do first; and the Output tab (ADR 0099). */
class AtticusToolWindowFactory :
    ToolWindowFactory,
    DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val cf = ContentFactory.getInstance()
        val d = toolWindow.disposable
        val app = AppPanel(project, d)
        // ADR 0105 addendum 2: the tabs in the order of a working day — what is next, what waits
        // on me, my changes, the repos, what the organisation knows, then the model's own work;
        // the app and the Output last. Each tree reads itself when its tab is first shown.
        val trees: List<Pair<String, RowTree>> =
            listOf(
                Copy.NEXT_TAB to NextPanel(project, d),
                Copy.WAITING_TAB to WaitingPanel(project, d),
                Copy.CHANGES_TAB to ChangesPanel(project, d),
                Copy.REPOS_TAB to ReposPanel(project, d),
                Copy.KNOWLEDGE_TAB to KnowledgePanel(project, d),
                Copy.RUNS_TAB to RunsPanel(project, d),
                Copy.HISTORY_TAB to HistoryPanel(project, d),
            )
        for ((name, panel) in trees) toolWindow.contentManager.addContent(cf.createContent(panel, name, false))
        toolWindow.contentManager.addContent(cf.createContent(app, Copy.APP_TAB, false))
        toolWindow.contentManager.addContent(cf.createContent(LogPanel(project, d), Copy.OUTPUT_TAB, false))
        AtticusTrees.of(project).register(trees.map { it.second })
        for ((_, panel) in trees) panel.refresh()
        val service = AtticusApp.of(project)
        if (service.state == AppState.Checking) service.refresh() else app.show(service.state)
    }
}

/** The app in a browser panel, or a short panel that says what to do. */
class AppPanel(private val project: Project, parent: Disposable) : SimpleToolWindowPanel(true, true) {
    private var browser: JBCefBrowser? = null
    private var browserUrl: String? = null
    private val life = Disposer.newDisposable(parent, "Atticus app panel")

    init {
        val group = DefaultActionGroup()
        for (id in listOf("Atticus.Refresh", "Atticus.OpenInBrowser", "Atticus.RunCommand", "Atticus.NextStep", "Atticus.AnswerQuestion", "Atticus.WaitingOnYou", "Atticus.ModelRuns", "Atticus.PromptHistory")) {
            ActionManager.getInstance().getAction(id)?.let { group.add(it) }
        }
        val bar = ActionManager.getInstance().createActionToolbar("AtticusToolWindow", group, true)
        bar.targetComponent = this
        toolbar = bar.component
        AtticusApp.of(project).listen(life, { show(it) }, { browser?.cefBrowser?.reload() })
        AtticusApp.of(project).listenOpen(life) { hash -> browserUrl?.let { browser?.loadURL(Metarepo.screenUrl(it, hash)) } }
        show(AppState.Checking)
    }

    fun show(s: AppState) {
        if (s !is AppState.Running) dropBrowser()
        setContent(
            when (s) {
                AppState.Checking -> waiting(Copy.CHECKING)
                AppState.Starting -> waiting(Copy.STARTING)
                AppState.CliMissing -> cliMissing()
                AppState.NoMetarepo -> noMetarepo()
                is AppState.Running -> running(s.url)
                is AppState.Stopped -> stopped(s.message)
            },
        )
        revalidate()
        repaint()
    }

    private fun dropBrowser() {
        browser?.let { Disposer.dispose(it) }
        browser = null
        browserUrl = null
    }

    private fun waiting(text: String): JComponent =
        JPanel(BorderLayout()).apply {
            add(JBLabel(text, AnimatedIcon.Default(), SwingConstants.CENTER), BorderLayout.CENTER)
        }

    private fun padded(c: JComponent): JComponent = JBScrollPane(c.apply { border = JBUI.Borders.empty(12) }).apply { border = JBUI.Borders.empty() }

    private fun cliMissing(): JComponent =
        padded(
            panel {
                row { label(Copy.CLI_MISSING_TITLE).bold() }
                row { text(Copy.CLI_MISSING, maxLineLength = 60) }
                row { link(Copy.INSTALL_GUIDE) { BrowserUtil.browse(Words.INSTALL_URL) } }
                row {
                    button(Copy.SET_PATH) { ShowSettingsUtil.getInstance().showSettingsDialog(project, AtticusConfigurable::class.java) }
                    button(Copy.CHECK_AGAIN) { AtticusApp.of(project).refresh() }
                }
            },
        )

    private fun noMetarepo(): JComponent =
        padded(
            panel {
                row { label(Copy.NO_METAREPO_TITLE).bold() }
                row { text(Copy.NO_METAREPO, maxLineLength = 60) }
                row { button(Copy.CREATE_METAREPO) { StartFlow(project).createMetarepo() } }
                row { comment(Copy.CREATE_METAREPO_WHY, maxLineLength = 60) }
                row { button(Copy.ADOPT) { StartFlow(project).adopt() } }
                row { comment(Copy.ADOPT_WHY, maxLineLength = 60) }
                row { button(Copy.SANDBOX) { StartFlow(project).sandbox() } }
                row { comment(Copy.SANDBOX_WHY, maxLineLength = 60) }
            },
        )

    private fun stopped(message: String): JComponent =
        padded(
            panel {
                row { text(message, maxLineLength = 60) }
                row {
                    button(Copy.TRY_AGAIN) { AtticusApp.of(project).refresh() }
                    button(Copy.SHOW_OUTPUT) { AtticusWindow.showTab(project, Copy.OUTPUT_TAB) }
                }
            },
        )

    private fun running(url: String): JComponent {
        if (!JBCefApp.isSupported()) {
            return padded(
                panel {
                    row { text(Copy.NO_BROWSER, maxLineLength = 60) }
                    row { button(Copy.OPEN_IN_BROWSER) { BrowserUtil.browse(url) } }
                },
            )
        }
        val b = browser?.takeIf { browserUrl == url } ?: JBCefBrowser.createBuilder().setUrl(Metarepo.screenUrl(url, AtticusApp.of(project).screen)).build().also {
            dropBrowser()
            Disposer.register(life, it)
            browser = it
            browserUrl = url
            escapeToPage(it)
            saveDownloads(it)
            editorLinks(project, it)
        }
        return b.component
    }
}

/**
 * ADR 0166 (F10): Esc in the app is the app's (leave full screen, clear Find a box). The keymap
 * binds Esc to Focus Editor, and the platform runs a keymap action before the browser sees the
 * key, so the tool window takes Esc itself while the page has focus and hands it to the page.
 * Shift+Esc still hides the tool window; a click in the editor leaves it. F and / are bound to
 * nothing and reach the page as they are.
 */
private fun escapeToPage(b: JBCefBrowser) {
    object : com.intellij.openapi.project.DumbAwareAction() {
        override fun actionPerformed(e: com.intellij.openapi.actionSystem.AnActionEvent) {
            b.cefBrowser.executeJavaScript(com.maycombhq.atticus.core.Beta11.ESCAPE_TO_PAGE, b.cefBrowser.url, 0)
        }
    }.registerCustomShortcutSet(
        com.intellij.openapi.actionSystem.CustomShortcutSet(javax.swing.KeyStroke.getKeyStroke(java.awt.event.KeyEvent.VK_ESCAPE, 0)),
        b.component,
        b,
    )
}

/**
 * The canvas's exports (Mermaid, draw.io, SVG, PNG) are downloads. The embedded browser saves
 * none by itself, so each asks where with the system's Save dialog, under the name the app gave.
 */
private fun saveDownloads(b: JBCefBrowser) {
    b.jbCefClient.addDownloadHandler(
        object : org.cef.handler.CefDownloadHandlerAdapter() {
            override fun onBeforeDownload(
                browser: org.cef.browser.CefBrowser?,
                item: org.cef.callback.CefDownloadItem?,
                suggestedName: String?,
                callback: org.cef.callback.CefBeforeDownloadCallback?,
            ): Boolean {
                callback?.Continue(suggestedName ?: "", true)
                return true
            }
        },
        b.cefBrowser,
    )
}

/**
 * G6: the app's "Open in your editor" links. The embedded browser can't hand `idea://` to the
 * system, so a cited line opens here, in this IDE; a `vscode://` one goes to the system.
 */
private fun editorLinks(project: Project, b: JBCefBrowser) {
    b.jbCefClient.addRequestHandler(
        object : org.cef.handler.CefRequestHandlerAdapter() {
            override fun onBeforeBrowse(
                browser: org.cef.browser.CefBrowser?,
                frame: org.cef.browser.CefFrame?,
                request: org.cef.network.CefRequest?,
                userGesture: Boolean,
                isRedirect: Boolean,
            ): Boolean = openEditorLink(project, request?.url)

            override fun onOpenURLFromTab(
                browser: org.cef.browser.CefBrowser?,
                frame: org.cef.browser.CefFrame?,
                targetUrl: String?,
                userGesture: Boolean,
            ): Boolean = openEditorLink(project, targetUrl)
        },
        b.cefBrowser,
    )
}

/** True when the link was an editor's (handled here); false lets the browser go on. */
private fun openEditorLink(project: Project, url: String?): Boolean {
    if (url == null) return false
    if (url.startsWith("vscode://")) {
        BrowserUtil.browse(url)
        return true
    }
    if (!url.startsWith("idea://")) return false
    val query = runCatching { java.net.URI(url).rawQuery }.getOrNull() ?: return true
    val params =
        query.split("&").mapNotNull { kv ->
            val p = kv.split("=", limit = 2)
            if (p.size == 2) {
                java.net.URLDecoder.decode(p[0], Charsets.UTF_8) to
                    java.net.URLDecoder.decode(p[1], Charsets.UTF_8)
            } else {
                null
            }
        }.toMap()
    val file = params["file"] ?: return true
    val line = ((params["line"]?.toIntOrNull() ?: 1) - 1).coerceAtLeast(0)
    ApplicationManager.getApplication().invokeLater {
        val vf =
            com.intellij.openapi.vfs.LocalFileSystem.getInstance()
                .refreshAndFindFileByPath(file.replace('\\', '/'))
        if (vf != null && !project.isDisposed) {
            com.intellij.openapi.fileEditor.OpenFileDescriptor(project, vf, line, 0).navigate(true)
        }
    }
    return true
}

/** Every command run and what it printed. */
class LogPanel(project: Project, parent: Disposable) : JPanel(BorderLayout()) {
    private val area =
        JBTextArea().apply {
            isEditable = false
            font = Font(Font.MONOSPACED, Font.PLAIN, font.size)
        }

    init {
        val log = AtticusLog.of(project)
        area.text = log.all()
        add(JBScrollPane(area), BorderLayout.CENTER)
        log.listen(parent) { s ->
            ApplicationManager.getApplication().invokeLater {
                area.append(s)
                area.caretPosition = area.document.length
            }
        }
    }
}
