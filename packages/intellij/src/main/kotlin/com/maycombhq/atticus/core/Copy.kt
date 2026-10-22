package com.maycombhq.atticus.core

/**
 * The plugin's user-facing words, in one place (the copy file). Plain words first; a command is
 * beside them, not instead. The action names are in plugin.xml.
 */
object Copy {
    const val TOOL_WINDOW = "Atticus"
    const val OUTPUT_TAB = "Output"
    const val APP_TAB = "App"

    const val CHECKING = "Checking for the atticus command line…"
    const val STARTING = "Starting the Atticus app…"

    const val CLI_MISSING_TITLE = "Atticus's command line isn't installed here"
    const val CLI_MISSING =
        "The plugin runs the atticus command line, and couldn't start it. Install it from the offline " +
            "bundle (no network needed), or set the path to atticus if it is installed somewhere else."
    const val INSTALL_GUIDE = "How to install atticus"
    const val SET_PATH = "Set the path to atticus…"
    const val CHECK_AGAIN = "Check again"

    const val NO_METAREPO_TITLE = "No metarepo is open"
    const val NO_METAREPO =
        "Atticus works in a metarepo: a folder with org-pack/ that lists your repos and keeps what " +
            "Atticus learns about them. Open one, or start here."
    const val CREATE_METAREPO = "Create a metarepo…"
    const val CREATE_METAREPO_WHY = "A new folder for Atticus, next to your repos (atticus init)."
    const val ADOPT = "Use Atticus in this project"
    const val ADOPT_WHY = "Keeps Atticus's files in .atticus/ in this project; nothing else changes (atticus adopt)."
    const val SANDBOX = "Try a practice metarepo…"
    const val SANDBOX_WHY = "A throwaway metarepo with invented repos, to try Atticus on (atticus sandbox create)."

    const val NO_BROWSER = "This IDE can't show web pages in a panel (JCEF is off). Open the app in your browser instead."
    const val OPEN_IN_BROWSER = "Open in browser"
    const val TRY_AGAIN = "Try again"
    const val SHOW_OUTPUT = "Show output"

    fun appStopped(code: Int) = "The Atticus app stopped (exit $code). What it printed is in the Output tab."

    const val APP_NOT_RUNNING = "The Atticus app isn't running yet."

    // Run a command
    const val PICK_TITLE = "Atticus: run a command"
    const val NO_CATALOG = "Couldn't read atticus's commands"
    const val OPTIONS_TITLE = "Options (none needed; OK runs it)"
    const val NO_REPOS = "No repos yet: add them to a repos.manifest.yaml in org-pack/profiles."
    const val NO_CHANGES = "No changes yet: start one with change new."
    const val NO_QUESTIONS = "No question is waiting for an answer."
    const val PICK_OR_TYPE = "Pick one, or type it."

    fun argTitle(cmd: CatalogCommand, arg: CatalogArg) = "atticus ${cmd.id}: ${arg.name}${if (arg.optional) " (optional)" else ""}"

    fun flagPrompt(hint: String?) = if (hint != null) "Its value (for example $hint)" else "Its value"

    fun leaveEmpty(optional: Boolean) = if (optional) " Leave it empty to leave it out." else ""

    // AI steps
    const val AI_TITLE = "Run this step in Copilot Chat"

    fun aiStep(slash: String?) =
        if (slash != null) {
            "This is an AI step. In Copilot Chat, type <b>$slash</b>. The prompt files come from atticus assistant-files."
        } else {
            "This is an AI step, run by your assistant. Its prompt file comes from atticus assistant-files."
        }

    fun copy(what: String) = "Copy $what"

    const val RUN_HANDOFF = "Run its hand-off in a console instead"
    const val COPIED = "Copied."

    // Shared writes
    const val APPROVE_TITLE = "This writes to a shared system"
    const val APPROVE = "Approve and run"
    const val CANCEL = "Cancel"
    const val CLOSE = "Close"
    const val DRY_RUN_SAYS = "What the dry run says:"
    const val DRY_RUN_FAILED = "The dry run failed, so there is nothing to approve. Fix what it says, then run it again."

    fun approveWhat(command: String) = "Atticus ran it as a dry run first. Run it for real? $command"

    // Results
    fun done(id: String, first: String) = "atticus $id: $first"

    fun firstLine(lines: List<String>, code: Int) = lines.firstOrNull() ?: if (code == 0) "Done." else "It exited $code."

    fun couldNotRun(why: String) = "Couldn't run it: $why"

    // Next step
    const val NEXT_TITLE = "Atticus: next step"
    const val NO_NEXT = "Atticus has no next step to suggest."
    const val RUN_IT = "Run it"
    const val OPEN_APP = "Open the app"
    const val PERSON_STEP = "A person takes this step."

    fun couldNotReadNext(why: String) = "Couldn't read the next step: $why"

    // Start from nothing
    const val WHERE_METAREPO = "Where should the metarepo go? Pick the folder it goes in."
    const val METAREPO_NAME = "Its name: a new folder, for example payments-meta."
    const val PLATFORM = "The platform its repos belong to, in a word (for example payments). More can be added later."
    const val WHERE_SANDBOX = "Pick the folder the practice metarepo goes in."

    fun openIt(path: String) = "Open $path now?"

    const val OPEN = "Open"
    const val NOT_NOW = "Not now"

    // Settings
    const val SETTINGS_PATH = "Path to atticus:"
    const val SETTINGS_PATH_HINT =
        "Empty: atticus on PATH. Or its full path: atticus, atticus.cmd or its bin.js (run with node). " +
            "On Windows the plugin reads atticus.cmd and runs the bin.js it names, so no shell is used."
    const val SETTINGS_DEVELOPER = "Show the commands only Atticus's own developers use"
}
