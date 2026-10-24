package com.maycombhq.atticus.core

/** Where a VS Code command's job is done in IntelliJ (WP6.3). */
sealed interface InIntelliJ {
    /** An action of the plugin (plugin.xml). */
    data class Action(val id: String) : InIntelliJ

    /** Tools → Atticus: Run a Command…, which runs any command as its kind needs. */
    data object RunCommand : InIntelliJ

    /** A screen of the app in the tool window. */
    data class App(val hash: String) : InIntelliJ

    /** A tab of the tool window. */
    data class Tab(val name: String) : InIntelliJ

    /** VS Code only, and why: a limit said up front, not a gap left unsaid. */
    data class VsCodeOnly(val why: String) : InIntelliJ
}

/**
 * Every VS Code command and where IntelliJ does the same job (WP6.3). ParityTest fails when VS Code
 * gains a command this doesn't place, or names an action or screen that doesn't exist.
 */
object Parity {
    private val run = InIntelliJ.RunCommand
    private fun action(id: String) = InIntelliJ.Action(id)
    private fun app(hash: String) = InIntelliJ.App(hash)
    private val sidebar = InIntelliJ.VsCodeOnly("a filter or grouping of VS Code's sidebar views; the app's screens and the Waiting tree have their own")

    val MAP: Map<String, InIntelliJ> =
        linkedMapOf(
            "atticus.next" to action("Atticus.NextStep"),
            "atticus.runNext" to action("Atticus.NextStep"),
            "atticus.survey" to run,
            "atticus.verify" to run,
            "atticus.spec" to run,
            "atticus.feature" to run,
            "atticus.architecture" to run,
            "atticus.stories" to run,
            "atticus.small" to run,
            "atticus.answer" to action("Atticus.AnswerQuestion"),
            "atticus.ask" to run,
            "atticus.showApp" to app("#/home"),
            "atticus.diagram" to app("#/diagrams"),
            "atticus.changeDiagram" to action("Atticus.ChangeDiagram"),
            "atticus.estimate" to action("Atticus.Estimate"),
            "atticus.promptHistory" to action("Atticus.PromptHistory"),
            "atticus.openApp" to action("Atticus.OpenInBrowser"),
            "atticus.refresh" to action("Atticus.Refresh"),
            "atticus.waitingByKind" to sidebar,
            "atticus.waitingByChange" to sidebar,
            "atticus.filterWaiting" to sidebar,
            "atticus.clearFilterWaiting" to sidebar,
            "atticus.filterChanges" to sidebar,
            "atticus.clearFilterChanges" to sidebar,
            "atticus.filterKnowledge" to sidebar,
            "atticus.clearFilterKnowledge" to sidebar,
            "atticus.filterRuns" to sidebar,
            "atticus.clearFilterRuns" to sidebar,
            "atticus.openRunAnswer" to action("Atticus.ModelRuns"),
            "atticus.showLog" to InIntelliJ.Tab(Copy.OUTPUT_TAB),
            "atticus.openItem" to InIntelliJ.Tab(Copy.WAITING_TAB),
            "atticus.showStep" to app("#/flows"),
            "atticus.showFlow" to app("#/flows"),
            "atticus.findingAction" to run,
            "atticus.runCommand" to action("Atticus.RunCommand"),
            "atticus.newChange" to action("Atticus.NewChange"),
            "atticus.repoCommand" to run,
            "atticus.changeCommand" to run,
            "atticus.runTask" to run,
            "atticus.startTask" to action("Atticus.StartTask"),
            "atticus.attachToChange" to action("Atticus.AttachToChange"),
            "atticus.watchChange" to action("Atticus.WatchChange"),
            "atticus.addToKnowledge" to action("Atticus.AddToKnowledge"),
            "atticus.checkHealth" to run,
            "atticus.scanAll" to run,
            "atticus.estateJoin" to run,
            "atticus.workspaceSync" to run,
            "atticus.sourcesSync" to run,
            "atticus.knowledgeScan" to run,
            "atticus.knowledgeAsk" to run,
            "atticus.upgrade" to run,
            "atticus.setup" to run,
            "atticus.digest" to run,
            "atticus.runApproved" to run,
            "atticus.createMetarepo" to action("Atticus.CreateMetarepo"),
            "atticus.adoptRepo" to action("Atticus.Adopt"),
            "atticus.practiceSandbox" to action("Atticus.Sandbox"),
            "atticus.addRepos" to run,
            "atticus.draftSpec" to run,
            "atticus.answerRepo" to action("Atticus.AnswerQuestion"),
            "atticus.installCopilot" to InIntelliJ.VsCodeOnly("installs GitHub Copilot in VS Code; in IntelliJ it is installed from the Marketplace"),
            "atticus.pickModel" to
                InIntelliJ.VsCodeOnly("picks one of VS Code's language models; IntelliJ offers plugins none, so a step runs in Copilot Chat or on runtime.yaml's model"),
            "atticus.absorb" to run,
            "atticus.absorbAccept" to run,
            "atticus.onboardRepo" to run,
            "atticus.addKnowledge" to run,
            "atticus.acceptCatalog" to run,
            "atticus.setupStep" to run,
            "atticus.runStep" to run,
            "atticus.openOrgPackOwner" to app("#/orgpack"),
            "atticus.addWiki" to run,
            "atticus.searchWikis" to app("#/wiki-search"),
            "atticus.keepFound" to app("#/wiki-search"),
            "atticus.keepCandidate" to app("#/wiki-search"),
            "atticus.syncSource" to run,
            "atticus.readSource" to run,
            "atticus.tagSource" to run,
            "atticus.verifyItem" to app("#/knowledge"),
            "atticus.correctItem" to app("#/knowledge"),
            "atticus.rejectItem" to app("#/knowledge"),
            "atticus.openLinks" to app("#/knowledge"),
            "atticus.askAboutItem" to run,
            "atticus.findNeeds" to run,
            "atticus.needDone" to run,
            "atticus.needSkip" to run,
            "atticus.needReopen" to run,
            "atticus.openNeedPage" to app("#/home"),
            "atticus.raiseNeeds" to run,
            "atticus.draftOrgPack" to run,
            "atticus.reviewUnverified" to app("#/knowledge"),
            "atticus.showManualStep" to app("#/todo"),
        )
}
