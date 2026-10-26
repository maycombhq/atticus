package com.maycombhq.atticus.core

import java.nio.file.Files
import java.nio.file.Path

/** Where an AI step's work can be done from IntelliJ (ADR 0121 addendum 2, 2026-10-26). */
enum class RunStepHere {
    /** GitHub Copilot Chat in this IDE: the person pastes and sends; Atticus's CLI checks the answer. */
    COPILOT,

    /** Claude Code in a terminal opened in the metarepo (ADR 0104's plugin has the same slash commands). */
    CLAUDE_CODE,

    /** Atticus runs it on runtime.yaml's model, in a console here (ADR 0121 item 5). */
    MODEL,

    /** Only the deterministic half: the prompt is written for a model run elsewhere. */
    HANDOFF,
}

/**
 * What goes on the clipboard for Copilot Chat, in order of what works: the slash command when
 * `atticus assistant-files` has written its prompt file, else the prompt the hand-off wrote, else
 * nothing to copy yet.
 */
sealed interface ToPaste {
    /** The slash command Copilot's prompt file answers. */
    data class Slash(val slash: String) : ToPaste

    /** The prompt itself, read from the file the hand-off wrote. */
    data class Prompt(val path: String, val text: String) : ToPaste

    /** No prompt file and no prompt yet: write the prompt files first. */
    data class Nothing(val slash: String?) : ToPaste
}

/**
 * The hand-off of an AI step to an assistant in IntelliJ (ADR 0121 addendum 2). All of it is
 * worked out here, with no IDE, so the words and the choices are tested.
 *
 * IntelliJ's GitHub Copilot plugin publishes no extension point a third-party plugin can call:
 * there is no way to open Copilot Chat, send it a message or choose its model from here. So the
 * path is the clipboard and a notice: the step's slash command (or its prompt, where no prompt
 * file is written yet), the model class the step expects and the model that class names, for the
 * person to pick in Copilot's own picker. The person sends it; Copilot writes the answer where
 * the prompt says; `atticus` checks it as it always does, so nothing is trusted because Copilot
 * said it.
 */
object Handoff {
    /** What a step offers here, in the order the notice lists them. */
    fun ways(modelMode: Boolean): List<RunStepHere> =
        listOfNotNull(
            RunStepHere.COPILOT,
            RunStepHere.CLAUDE_CODE,
            if (modelMode) RunStepHere.MODEL else null,
            RunStepHere.HANDOFF,
        )

    /** What to put on the clipboard for Copilot Chat. */
    fun toPaste(metarepo: Path?, slash: String?, promptPath: String?): ToPaste {
        if (slash != null && metarepo != null && Peer.hasPromptFile(metarepo, slash)) return ToPaste.Slash(slash)
        val text = promptPath?.let { p -> metarepo?.resolve(p)?.takeIf { Files.isRegularFile(it) }?.let { runCatching { Files.readString(it) }.getOrNull() } }
        if (text != null && promptPath != null && text.isNotBlank()) return ToPaste.Prompt(promptPath, text)
        return ToPaste.Nothing(slash)
    }

    /**
     * The line that runs the step in Claude Code in a terminal here: `claude` in the metarepo,
     * then the step's slash command, which the Atticus plugin for Claude Code answers (ADR 0104).
     * The same slash command as Copilot's, so a person who moves between them types one thing.
     */
    fun claudeCodeArgv(slash: String): List<String> = listOf("claude", slash)

    /**
     * The notice, in order: what to do, the model class and model the step expects, how steps run
     * in this metarepo, and the one limit, said plainly. Lines, joined by the caller.
     */
    fun notice(
        paste: ToPaste,
        expects: ExpectedModel?,
        runs: String?,
        copilotApi: Boolean = false,
    ): List<String> =
        buildList {
            add(
                when (paste) {
                    is ToPaste.Slash -> Copy.pasteSlash(paste.slash)
                    is ToPaste.Prompt -> Copy.pastePrompt(paste.path)
                    is ToPaste.Nothing -> paste.slash?.let { Copy.noPromptFile(it) } ?: Copy.aiStep(null)
                },
            )
            if (expects != null) add(Copy.expectsModel(expects))
            if (runs != null) add(Copy.howStepsRun(runs))
            add(if (copilotApi) Copy.COPILOT_API else Copy.COPILOT_NO_API)
            add(Copy.CLI_CHECKS_THE_ANSWER)
        }

    /**
     * Whether anything programmatic of IntelliJ's Copilot plugin is reachable. The plugin looks
     * for an action id Copilot would have to register for a chat to be opened from here; nothing
     * is assumed when it isn't there, and the notice says so (never implying more).
     */
    const val COPILOT_CHAT_ACTION = "copilot.chat.show"

    /** The Copilot plugin's id in the Marketplace, for the words that say where to get it. */
    const val COPILOT_PLUGIN_ID = "com.github.copilot"
}
