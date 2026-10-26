package com.maycombhq.atticus.ide

import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.extensions.PluginId
import com.maycombhq.atticus.core.Handoff

/**
 * What GitHub Copilot's IntelliJ plugin gives Atticus to work with (ADR 0121 addendum 2).
 *
 * Its plugin publishes no extension point, service or API a third-party plugin can call: there is
 * no way to send Copilot Chat a message, read its chats or choose its model from here. The one
 * thing that is reachable is the IDE's own action registry, so the plugin *looks for* the action
 * that opens the chat and asks the IDE to run it when it is registered. Nothing is assumed when
 * it isn't: the notice then says only that the prompt is on the clipboard, and never implies more.
 */
object Copilot {
    /** Whether the Copilot plugin is installed and on in this IDE. */
    fun installed(): Boolean = PluginManagerCore.isLoaded(PluginId.getId(Handoff.COPILOT_PLUGIN_ID))

    /** The action that opens Copilot Chat, when its plugin registers one; null when it doesn't. */
    fun chatAction(): AnAction? = ActionManager.getInstance().getAction(Handoff.COPILOT_CHAT_ACTION)

    /**
     * Open Copilot Chat, where that action exists. The IDE runs it (`tryToExecute`), rather than
     * the plugin calling `actionPerformed` itself, which is for the IDE to do.
     */
    fun openChat(): Boolean {
        val action = chatAction() ?: return false
        ActionManager.getInstance().tryToExecute(action, null, null, ActionPlaces.UNKNOWN, true)
        return true
    }
}
