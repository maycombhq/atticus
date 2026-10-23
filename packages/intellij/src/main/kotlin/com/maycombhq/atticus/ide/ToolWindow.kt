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
        val app = AppPanel(project, toolWindow.disposable)
        toolWindow.contentManager.addContent(cf.createContent(app, Copy.APP_TAB, false))
        toolWindow.contentManager.addContent(cf.createContent(LogPanel(project, toolWindow.disposable), Copy.OUTPUT_TAB, false))
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
        for (id in listOf("Atticus.Refresh", "Atticus.OpenInBrowser", "Atticus.RunCommand", "Atticus.NextStep", "Atticus.WaitingOnYou", "Atticus.ModelRuns")) {
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
        }
        return b.component
    }
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
