package com.maycombhq.atticus.core

/**
 * The plugin's user-facing words, in one place (the copy file). Plain words first; a command is
 * beside them, not instead. The action names are in plugin.xml.
 */
object Copy {
    const val TOOL_WINDOW = "Atticus"
    const val OUTPUT_TAB = "Output"
    const val APP_TAB = "App"

    // ADR 0105 addendum 2 (2026-10-26): the tool window's tabs, what VS Code's sidebar offers.
    const val NEXT_TAB = "Next"
    const val CHANGES_TAB = "Changes"
    const val REPOS_TAB = "Repos"
    const val KNOWLEDGE_TAB = "Knowledge"
    const val RUNS_TAB = "Model runs"
    const val HISTORY_TAB = "Prompt history"

    // The filter and the grouping each tree's toolbar offers.
    const val FILTER = "Filter…"
    const val FILTER_HINT = "Filter: words to match, for example forge-ledger"
    const val CLEAR_FILTER = "Clear filter"
    const val GROUP_BY_CHANGE = "By change"
    const val GROUP_BY_KIND = "By kind"

    fun filtered(filter: String) = "Filtered by “$filter”."

    fun nothingMatched(filter: String) = "Nothing matches “$filter”. Clear the filter to see everything."

    // Repos (ADR 0128: what a repo is, in a person's words)
    const val REPO_NO_DESCRIPTION = "Nothing says what it is yet"
    const val REPOS_READING = "Reading the repos…"
    const val REPOS_NONE = "No repos yet: add them to a repos.manifest.yaml in org-pack/profiles."

    fun repoDraftDescription(text: String) = "$text — drafted by your assistant, unconfirmed"

    // Changes
    const val CHANGES_READING = "Reading the changes…"

    fun fromStore(store: String) = "OpenSpec store $store (read-only)"

    fun riskLine(level: String, score: Int?) = "risk $level${score?.let { " ($it)" } ?: ""}"

    fun testKinds(kinds: List<String>) = "tests: ${kinds.joinToString(", ")}"

    fun tasksLine(done: Int, total: Int) = "$done/$total tasks"

    // A task's knowledge (B-task-knowledge)
    const val TASK_KNOWLEDGE = "Knowledge for this task"
    const val KNOWLEDGE_VERIFIED = "verified"
    const val KNOWLEDGE_UNVERIFIED = "not verified"

    fun alsoOn(n: Int) = "also on $n other page${if (n == 1) "" else "s"}"

    fun conflictAsked(question: String) = "Pages disagree, so a person is asked: $question"

    // A call's path through gateways (ADR 0124 addendum A-gateway2)
    const val CALL_PATHS = "Calls through gateways"
    const val CALL_PATHS_NONE = "No joined call-out goes through a gateway: run atticus estate join."

    fun throughGateways(n: Int) = "$n gateway hop${if (n == 1) "" else "s"}"

    fun gatewayAuth(auth: String) = "auth $auth"

    fun gatewayScopes(scopes: List<String>) = "scopes ${scopes.joinToString(", ")}"

    fun gatewayFacing(facing: String) = facing

    // Knowledge (ADR 0101, 0105)
    const val KNOWLEDGE_SOURCES = "Wikis and docs repos"

    fun sourceOwner(owner: String) = "owned by $owner"

    const val KNOWLEDGE_TO_CHECK = "No one has checked these"
    const val KNOWLEDGE_CHECKED = "Checked"
    const val OPENSPEC_ARTIFACTS = "OpenSpec stores (read-only, beta)"

    // Model runs and prompt history
    const val RUNS_READING = "Reading the model runs…"
    const val RUNS_NONE = "No model runs yet: an AI step makes one, and its prompt and answer are kept under .runs/."
    const val RUN_NOT_ANSWERED = "no answer yet"

    fun runRound(n: Int) = "round $n"

    fun handedBack(n: Int) = "$n handed back"

    const val HISTORY_READING = "Reading the prompt history…"
    const val HISTORY_NONE =
        "No prompts yet. Claude Code's (with the Atticus plugin) and @atticus's in VS Code are recorded here; " +
            "Copilot's chats in IntelliJ can't be, because its plugin gives a plugin no way to read them."
    const val NO_RESPONSE_YET = "no response yet"
    const val HISTORY_OFF = "Recording is off: atticus history off turned it off."

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

    // ADR 0121 addendum 2 (2026-10-26): the Copilot path in IntelliJ, said plainly.
    fun pasteSlash(slash: String) = "<b>$slash</b> is on the clipboard. Open Copilot Chat (⌥⇧C / Alt+Shift+C) and paste it."

    fun pastePrompt(path: String) =
        "The step's prompt is on the clipboard (Atticus wrote it to $path). Open Copilot Chat, paste it and send it."

    const val COPILOT_NO_API =
        "GitHub Copilot's IntelliJ plugin publishes nothing a plugin can call, so Atticus can't open its chat, " +
            "send the prompt or pick its model for you. The clipboard and this notice are the whole of it."
    const val COPILOT_API = "Atticus opened Copilot Chat for you; the prompt is on the clipboard either way."
    const val CLI_CHECKS_THE_ANSWER =
        "Copilot writes the answer where the prompt says; atticus then checks it as it always does, " +
            "so nothing is taken on trust because Copilot said it."
    const val RUN_IN_CLAUDE_CODE = "Run it in Claude Code in a terminal"
    const val CLAUDE_CODE_WHY =
        "Opens claude in the metarepo with the same slash command: the Atticus plugin for Claude Code answers it (ADR 0104)."
    const val OPEN_COPILOT_CHAT = "Open Copilot Chat"
    const val COPILOT_MISSING =
        "GitHub Copilot isn't installed in this IDE. Install it from Settings → Plugins (GitHub Copilot), " +
            "or run the step in Claude Code or on Atticus's configured model instead."

    // The native actions' own words (ADR 0105 addendum 2)
    const val WHICH_REPO = "Which repo?"
    const val WHICH_CHANGE = "Which change?"
    const val ASK_CATALOG_TITLE = "Atticus: ask the catalog"
    const val ASK_CATALOG_PROMPT =
        "A plain question, for example: which systems call forge-ledger? The answer says the query it ran."
    const val NOTHING_SELECTED = "Pick a row in the Atticus tool window first."
    const val FINDING_ACTION_TITLE = "Atticus: act on a finding"
    const val FINDING_WHICH_ACTION = "What do you want to do with this finding?"
    const val FINDING_APPLY = "Apply the fix"
    const val FINDING_FIXED_BY_HAND = "I fixed it by hand"
    const val FINDING_NOT_RELEVANT = "Not relevant"
    const val FINDING_WAIVE = "Waive it"
    const val FINDING_ASK_SOMEONE = "Ask someone"
    const val FINDING_WROTE_IT_IN = "I wrote the fact in"
    const val FINDING_REASON = "Why? It is recorded with the finding, under your name."
    const val FINDING_ASKED_OF = "Who should answer? A person's handle or a role."

    fun findingAsk(owner: String) = "Ask $owner"
    const val NEED_NOTE = "Why isn't it needed? The note goes on the need."
    const val RAISE_NEEDS_TITLE = "Atticus: raise a change's open needs"
    const val NEED_NOT_NEEDED = "Atticus: not needed"
    const val ADD_KNOWLEDGE_TITLE = "Atticus: add knowledge"
    const val ADD_KNOWLEDGE_HOW = "Where does the knowledge come from?"
    const val ADD_KNOWLEDGE_BRING_IN = "Bring in from another repo"
    const val ADD_KNOWLEDGE_WIKI = "Add a wiki or docs repo…"
    const val ADD_KNOWLEDGE_FILES = "Add files from the Project view"

    /** The title of the dialog a native step asks its target in: the command it runs. */
    fun stepTitle(words: List<String>) = "Atticus: ${words.joinToString(" ")}"

    fun raiseNeeds(change: String) =
        "$change's open needs are on its page, each with Done, Not needed and Reopen. Mark them there, or pick one in Waiting on you."

    fun taskKnowledgeTitle(task: String) = "Atticus: knowledge for task $task"

    fun noTaskKnowledge(task: String) =
        "No knowledge page applies to task $task yet. Sync the sources and read them (/atticus-knowledge), then try again."

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

    /**
     * ADR 0121 addendum: IntelliJ can't choose Copilot's model for a plugin, so the hand-off text
     * names the model the step expects, for the person to pick in Copilot's own picker.
     */
    fun expectsModel(e: ExpectedModel) =
        "This is a ${e.stepClass.id} step: it expects ${e.model} (" +
            (if (e.from == ModelFrom.SETTING) "your setting" else "runtime.yaml models.${e.stepClass.id}") +
            "). Pick it in Copilot's model picker before you send the prompt."
    const val THE_PROMPT = "the prompt"
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

    // ADR 0105 addendum: the kinds of thing that wait, and the group for what belongs to no change.
    const val WAITING_NEEDS = "Needs still open"
    const val WAITING_FINDINGS = "Findings open"
    const val WAITING_MANUAL = "Manual steps to do"
    const val WAITING_KNOWLEDGE = "Knowledge to check"
    const val WAITING_NO_CHANGE = "Not on any change"
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

    // ADR 0121 addendum: a model per kind of step
    const val SETTINGS_MODELS = "Model for each kind of step"
    const val SETTINGS_MODELS_HINT =
        "Each overrides runtime.yaml's models.<kind> for you. vendor/family (such as copilot/claude-opus-4.5) is " +
            "named in the hand-off text, for you to pick in Copilot's model picker: IntelliJ can't pick it for you. " +
            "A model of runtime.yaml's provider is used when a step runs on Atticus's configured model. " +
            "Empty: runtime.yaml's, else Copilot's own choice."

    fun settingsModel(c: StepClass) = "${c.id.replaceFirstChar { it.uppercase() }} steps:"

    fun settingsModelHint(c: StepClass) =
        when (c) {
            StepClass.READ -> "Reading repos into facts (atticus map), and scan verify."
            StepClass.DRAFT -> "The feature, architecture and stories drafts, small changes, spec drafts and scan surveys."
            StepClass.CRITIC -> "The critic's lenses, and the hand-up lens."
            StepClass.KNOWLEDGE -> "The knowledge scan and find, what a change needs, and knowledge ask."
            StepClass.QUICK -> "Everything small: judgments, context expansion and ordering, names and short texts."
        }
}
