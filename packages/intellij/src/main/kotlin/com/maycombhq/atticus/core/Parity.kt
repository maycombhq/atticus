package com.maycombhq.atticus.core

/** Where a VS Code command's job is done in IntelliJ (WP6.3, ADR 0105 addendum 2). */
sealed interface InIntelliJ {
    /** An action of the plugin (plugin.xml): its own entry in the Tools menu and Find Action. */
    data class Action(val id: String) : InIntelliJ

    /**
     * Tools → Atticus: Run a Command…, which runs any command as its kind needs. Only where
     * running a command is genuinely the job: the ADR names each one that is left.
     */
    data object RunCommand : InIntelliJ

    /** A screen of the app in the tool window. */
    data class App(val hash: String) : InIntelliJ

    /** A tab of the tool window. */
    data class Tab(val name: String) : InIntelliJ

    /** A part of a dialog or a flow here, not a command of its own; [where] says which. */
    data class Dialog(val where: String) : InIntelliJ

    /** VS Code only, and why: a limit said up front, not a gap left unsaid. */
    data class VsCodeOnly(val why: String) : InIntelliJ
}

/**
 * Every VS Code command and where IntelliJ does the same job (WP6.3, ADR 0105 addendum 2).
 * ParityTest fails when VS Code gains a command this doesn't place, or names an action or screen
 * that doesn't exist; ParityBudgetTest fails when the Run a Command entries grow past what the
 * ADR records.
 */
object Parity {
    private fun action(id: String) = InIntelliJ.Action(id)

    private fun app(hash: String) = InIntelliJ.App(hash)

    private fun tab(name: String) = InIntelliJ.Tab(name)

    /** The number of Run a Command entries ADR 0105 addendum 2 records, and what each one is. */
    const val RUN_COMMAND_BUDGET = 2

    /**
     * Each action a step of [Steps] does, by the VS Code command it answers: the AI steps handed
     * to Copilot Chat, and the commands Atticus runs itself.
     */
    private val FROM_STEPS: Map<String, InIntelliJ> = Steps.ALL.associate { it.vsCode to action(it.actionId) }

    val MAP: Map<String, InIntelliJ> =
        linkedMapOf<String, InIntelliJ>().apply {
            // ---------------------------------------------------------- what is next
            put("atticus.next", action("Atticus.NextStep"))
            put("atticus.runNext", action("Atticus.NextStep"))
            // The Next tab lists the next step and the setup checklist, each row with Run the step.
            put("atticus.setup", tab(Copy.NEXT_TAB))
            put("atticus.runStep", action("Atticus.RunStep"))
            put("atticus.setupStep", action("Atticus.RunStep"))

            // ---------------------------------------------------------- what waits on you
            put("atticus.openItem", tab(Copy.WAITING_TAB))
            put("atticus.answer", action("Atticus.AnswerQuestion"))
            put("atticus.answerRepo", action("Atticus.AnswerQuestion"))
            put("atticus.waitingByChange", action("Atticus.WaitingByChange"))
            put("atticus.waitingByKind", action("Atticus.WaitingByKind"))
            put("atticus.filterWaiting", action("Atticus.FilterWaiting"))
            put("atticus.clearFilterWaiting", action("Atticus.ClearFilterWaiting"))
            put("atticus.findingAction", action("Atticus.FindingAction"))
            put("atticus.raiseNeeds", action("Atticus.RaiseNeeds"))
            put("atticus.openNeedPage", app("#/home"))

            // ---------------------------------------------------------- my changes
            put("atticus.newChange", action("Atticus.NewChange"))
            put("atticus.watchChange", action("Atticus.WatchChange"))
            put("atticus.attachToChange", action("Atticus.AttachToChange"))
            put("atticus.startTask", action("Atticus.StartTask"))
            put("atticus.changeDiagram", action("Atticus.ChangeDiagram"))
            put("atticus.estimate", action("Atticus.Estimate"))
            put("atticus.filterChanges", action("Atticus.FilterChanges"))
            put("atticus.clearFilterChanges", action("Atticus.ClearFilterChanges"))

            // ---------------------------------------------------------- what the organisation knows
            put("atticus.addToKnowledge", action("Atticus.AddToKnowledge"))
            // One action offering the three ways in: bring in a repo, add a wiki, add files.
            put("atticus.addKnowledge", action("Atticus.AddKnowledge"))
            put("atticus.filterKnowledge", action("Atticus.FilterKnowledge"))
            put("atticus.clearFilterKnowledge", action("Atticus.ClearFilterKnowledge"))
            // The Knowledge tab's own list is what no one has checked, newest first.
            put("atticus.reviewUnverified", tab(Copy.KNOWLEDGE_TAB))
            put("atticus.searchWikis", app("#/wiki-search"))
            put("atticus.keepFound", app("#/wiki-search"))
            put("atticus.keepCandidate", app("#/wiki-search"))
            put("atticus.openLinks", app("#/knowledge"))

            // ---------------------------------------------------------- the estate and its setup
            put("atticus.showApp", app("#/home"))
            put("atticus.openApp", action("Atticus.OpenInBrowser"))
            put("atticus.refresh", action("Atticus.Refresh"))
            put("atticus.diagram", app("#/diagrams"))
            put("atticus.showStep", app("#/flows"))
            put("atticus.showFlow", app("#/flows"))
            put("atticus.createMetarepo", action("Atticus.CreateMetarepo"))
            put("atticus.adoptRepo", action("Atticus.Adopt"))
            put("atticus.practiceSandbox", action("Atticus.Sandbox"))

            // ---------------------------------------------------------- the model's own work
            put("atticus.promptHistory", tab(Copy.HISTORY_TAB))
            put("atticus.openRunAnswer", tab(Copy.RUNS_TAB))
            put("atticus.filterRuns", action("Atticus.FilterRuns"))
            put("atticus.clearFilterRuns", action("Atticus.ClearFilterRuns"))
            put("atticus.showLog", tab(Copy.OUTPUT_TAB))

            // ---------------------------------------------------------- the steps and the commands
            putAll(FROM_STEPS)

            // ---------------------------------------------------------- what is not a command here
            // The dry run's yes, inside the dialog that shows what the dry run said (ADR 0099).
            put("atticus.runApproved", InIntelliJ.Dialog(Copy.APPROVE))

            // Running a command on a repo or a change is the job itself: the two that are left.
            put("atticus.repoCommand", InIntelliJ.RunCommand)
            put("atticus.changeCommand", InIntelliJ.RunCommand)
            put("atticus.runCommand", action("Atticus.RunCommand"))

            // ---------------------------------------------------------- VS Code only, and why
            put(
                "atticus.installCopilot",
                InIntelliJ.VsCodeOnly(
                    "installs GitHub Copilot in VS Code, which has it built in from 1.143; IntelliJ's is a " +
                        "Marketplace plugin a plugin can't install, so Atticus says where to get it instead",
                ),
            )
            put(
                "atticus.pickModel",
                InIntelliJ.VsCodeOnly(
                    "picks one of VS Code's language models for the extension to call. IntelliJ offers plugins " +
                        "none, and Copilot's IntelliJ plugin exposes no model picker, so a step says the model " +
                        "its class expects and the person picks it in Copilot's own picker, or it runs on " +
                        "runtime.yaml's model (ADR 0121 addendum 2)",
                ),
            )
        }

    /** The Run a Command entries that are left, for the test and the ADR. */
    val RUN_COMMANDS: List<String> = MAP.filterValues { it is InIntelliJ.RunCommand }.keys.toList()

    /** How many commands land on each kind, for the ADR's table and the budget test. */
    fun counts(): Map<String, Int> =
        mapOf(
            "action" to MAP.values.count { it is InIntelliJ.Action },
            "app" to MAP.values.count { it is InIntelliJ.App },
            "tab" to MAP.values.count { it is InIntelliJ.Tab },
            "dialog" to MAP.values.count { it is InIntelliJ.Dialog },
            "runCommand" to MAP.values.count { it is InIntelliJ.RunCommand },
            "vsCodeOnly" to MAP.values.count { it is InIntelliJ.VsCodeOnly },
        )
}
