package com.maycombhq.atticus.ide

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.Consumer
import com.maycombhq.atticus.core.Copy
import com.maycombhq.atticus.core.Peer
import java.awt.Component
import java.awt.event.MouseEvent

/** The status bar (WP6.2): the open questions, the next step and the changes watched; a click shows the next step. */
class AtticusStatusWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = AtticusStatusWidget.ID

    override fun getDisplayName() = Copy.TOOL_WINDOW

    override fun isAvailable(project: Project) = Roots.metarepo(project) != null

    override fun createWidget(project: Project): StatusBarWidget = AtticusStatusWidget(project)
}

class AtticusStatusWidget(private val project: Project) :
    StatusBarWidget,
    StatusBarWidget.TextPresentation {
    private var bar: StatusBar? = null
    private var text = Copy.TOOL_WINDOW
    private var tip = Copy.STATUS_TIP

    override fun ID() = ID

    override fun install(statusBar: StatusBar) {
        bar = statusBar
        AtticusStatus.of(project).listen(this) { s ->
            text =
                if (!s.cliOk) {
                    Copy.STATUS_NO_CLI
                } else {
                    Peer.statusText(s.waiting?.questions?.size, s.next?.next, s.watched.size)
                }
            tip =
                listOfNotNull(
                    s.next?.next?.let { "Next: ${it.command}\n${it.why}" } ?: Copy.STATUS_TIP,
                    s.watched.takeIf { it.isNotEmpty() }?.let { (listOf(Copy.CHANGES_YOU_WATCH) + it).joinToString("\n") },
                ).joinToString("\n\n")
            bar?.updateWidget(ID)
        }
    }

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun getText() = text

    override fun getTooltipText() = tip

    override fun getAlignment() = Component.LEFT_ALIGNMENT

    override fun getClickConsumer(): Consumer<MouseEvent> = Consumer { NextFlow(project).show() }

    // The platform disposes the widget, and with it the listener registered under it.
    override fun dispose() {
        bar = null
    }

    companion object {
        const val ID = "AtticusStatus"
    }
}
