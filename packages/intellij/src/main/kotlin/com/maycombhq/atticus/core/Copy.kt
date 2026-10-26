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
        "The plugin runs the atticus command line, and couldn't start it. Install it with " +
            "npm install -g @maycombhq/atticus (from your npm mirror) or from the offline bundle " +
            "(no network needed), or set the path to atticus if it is installed somewhere else."
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
    const val OPEN_PROMPT = "Open the prompt"
    const val CHANGE_DIAGRAM = "Atticus: Change Diagram"
    const val ESTIMATE = "Atticus: Estimate"
    const val CHANGE_DIAGRAM_ASK = "Which change? Its id, such as add-transfer-limit."
    const val MODEL_RUNS = "Model runs"

    // ADR 0113: files into a change, and a task's context where the code is written
    const val ATTACH_TITLE = "Atticus: Attach to Change"
    const val ATTACH_WHICH_CHANGE = "Attach to which change?"
    const val ATTACH_NO_FILES = "Pick one or more files in the Project view first."
    const val START_TASK_TITLE = "Atticus: Start a Task in Copilot"
    const val START_TASK_WHICH_CHANGE = "Start a task of which change?"
    const val START_TASK_WHICH_TASK = "Which task?"

    fun noTasks(change: String) = "$change has no tasks yet: plan its stories first (Atticus: Next Step says how)."

    fun taskContextCopied(task: String, slash: String) =
        "Task $task's context is on the clipboard. Open Copilot Chat in agent mode and paste it, or type <b>$slash</b> there " +
            "to have Copilot read it itself. Copilot in IntelliJ offers plugins no way to open its chat, so the plugin can't do it for you."

    fun couldNotReadTask(why: String) = "Couldn't read the task's context: $why"

    fun promptWritten(path: String) =
        "Atticus wrote the step's prompt to $path. Answer it in your assistant (its slash command in Copilot Chat does it for you), then finish the step as the console says."
    const val NO_KNOWLEDGE = "No knowledge items yet: add a wiki, sync it, and read it with /atticus-knowledge in Copilot Chat."
    const val NO_NEEDS = "No needs yet: find them with /atticus-needs <change> in Copilot Chat."
    const val NO_FEATURES = "The catalog has no features yet: run atticus scan."
    const val NO_TODOS = "No manual steps yet: a change's plan writes them."
    const val NO_TRIAGE = "Nothing waits for triage: the drawings and the code agree."
    const val NO_TERMS = "The glossary has no terms yet: atticus glossary scan reads them."
    const val NO_FINDINGS = "The change has no open findings."
    const val NO_PROPOSALS = "No proposal yet: atticus onboard drafts one."
    const val NO_STORIES = "The change has no stories yet: write them with /atticus-stories <change> in Copilot Chat."
    const val NO_FLOWS = "No repo has a spec yet: draft one with /atticus-spec <repo> in Copilot Chat."
    const val NO_RECORDS = "The catalog is empty: run atticus scan."

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

    /** ADR 0121 item 5: the step run by Atticus on runtime.yaml's model, in a console here. */
    const val RUN_MODEL = "Run it on Atticus's configured model"

    /** ADR 0121 item 6: what runs a step here, in one line. */
    fun howStepsRun(runs: String) = "How AI steps run here: $runs"
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

    // WP6: IntelliJ as a peer
    const val WAITING_TAB = "Waiting on you"
    const val WAITING_QUESTIONS = "Questions to answer"
    const val WAITING_CHANGES = "Changes"
    const val WAITING_NOTHING = "Nothing waits on you."
    const val WAITING_READING = "Reading what waits on you…"

    fun waitingKnowledge(n: Int) = "$n knowledge item${if (n == 1) "" else "s"} no one has checked"

    fun waitingCouldNotRead(why: String) = "Couldn't read what waits on you: $why"

    const val WAITING_HINT = "Double-click a question to answer it, a change to open it, knowledge to check it in the app."

    const val ANSWER_TITLE = "Atticus: Answer a Question"
    const val ANSWER_OWN_WORDS = "In my own words"
    const val ANSWER_IT_READ = "What it read:"
    const val ANSWER_PICK = "Pick an answer, or write your own."
    const val ANSWER_NONE = "No question is waiting for an answer."

    fun answered(first: String) = "Answered. $first"

    const val WATCH_TITLE = "Atticus: Watch a Change"
    const val WATCH_WHICH = "Watch which change? Your digest and the status bar say how it is doing."
    const val NEW_CHANGE_TITLE = "Atticus: New Change"
    const val NEW_CHANGE_ASK = "What the change is, in a few words (for example: Let members pin a message)."
    const val START_FROM_TITLE = "Start from an earlier change?"
    const val START_FROM_NOTHING = "Start from nothing"
    const val START_FROM_HINT = "An earlier change you pick is attached to the new one as an example its steps read, as data."

    const val ADOPT_CONFIRM_TITLE = "Use Atticus in this project?"

    fun adoptConfirm(path: String) =
        "Atticus keeps its files in .atticus/ in $path, and adds .atticus/ entries to .gitignore where they are only yours. Nothing else in the project changes. Go on?"

    const val NAME_RULE = "Lower case letters, digits, dots and hyphens, starting with a letter or digit (for example payments-meta)."
    const val PLATFORM_RULE = "One word in lower case, hyphens allowed (for example payments)."

    fun noPromptFile(slash: String) =
        "This metarepo has no Copilot prompt file for $slash yet. Run atticus assistant-files to write them, then type it in Copilot Chat."

    const val WRITE_PROMPT_FILES = "Write the prompt files"

    const val STATUS_TIP = "Click for the next step"
    const val STATUS_NO_CLI = "Atticus: no command line"
    const val CHANGES_YOU_WATCH = "Changes you watch:"
    const val DONT_SHOW_AGAIN = "Don't show again"

    const val GUTTER_OPEN_FLOW = "Open the flow"

    fun gutterOpenChange(change: String) = "Open $change"

    const val GUTTER_IMPACT = "What breaks if this changes"
    const val SETTINGS_CHECK = "Check"

    fun settingsChecked(version: String) = "Found atticus $version."

    fun settingsCheckFailed(why: String) = "Couldn't run atticus: $why"

    // Settings
    const val SETTINGS_PATH = "Path to atticus:"
    const val SETTINGS_PATH_HINT =
        "Empty: atticus on PATH. Or its full path: atticus, atticus.cmd or its bin.js (run with node). " +
            "On Windows the plugin reads atticus.cmd and runs the bin.js it names, so no shell is used."
    const val SETTINGS_CLI_NOTICE = "Say when a project opens and the atticus command line can't be found"
    const val SETTINGS_DEVELOPER = "Show the commands only Atticus's own developers use"
}
