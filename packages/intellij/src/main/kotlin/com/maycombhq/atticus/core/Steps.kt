package com.maycombhq.atticus.core

/** What a native action asks for before it runs: a repo, a change, or nothing. */
enum class StepTarget { REPO, CHANGE, NONE }

/**
 * An action of the plugin that does one named job, as the VS Code command of the same name does
 * (ADR 0105 addendum 2, 2026-10-26). Each is its own entry in plugin.xml, so it is in the Tools
 * menu and in Find Action by its own words, instead of being reached by picking a command out of
 * Run a Command.
 *
 * [ai] says how it runs: an AI step goes to Copilot Chat (its slash command and the model class
 * it expects), and anything else runs on the command line as its kind needs (ADR 0099), with the
 * options the person adds asked as Run a Command asks them.
 */
data class NativeStep(
    /** The action id in plugin.xml. */
    val actionId: String,
    /** The VS Code command it answers (Parity.MAP's key). */
    val vsCode: String,
    val target: StepTarget,
    /** The command's words, before the target and the options. */
    val words: List<String>,
    val ai: Boolean,
) {
    /** The command, with the target when it takes one. */
    fun argv(target: String?): List<String> = if (target.isNullOrBlank()) words else words + target.trim()

    /** The slash command the step runs by in Copilot Chat, when it is an AI step. */
    fun slash(target: String?): String? = if (ai) Commands.slashFor(argv(target)) else null
}

/**
 * Every job IntelliJ does with an action of its own (ADR 0105 addendum 2). Parity.MAP is built
 * from this, so an action listed here and missing from plugin.xml fails ParityTest.
 */
object Steps {
    private fun ai(actionId: String, vsCode: String, target: StepTarget, vararg words: String) =
        NativeStep(actionId, vsCode, target, words.toList(), ai = true)

    private fun cmd(actionId: String, vsCode: String, target: StepTarget, vararg words: String) =
        NativeStep(actionId, vsCode, target, words.toList(), ai = false)

    /**
     * The AI steps: each hands its prompt and slash command to Copilot Chat, or runs on
     * runtime.yaml's model where the org pack allows it (ADR 0121 item 5, addendum 2026-10-26).
     */
    val AI: List<NativeStep> =
        listOf(
            ai("Atticus.ReadRepo", "atticus.map", StepTarget.REPO, "map"),
            ai("Atticus.Survey", "atticus.survey", StepTarget.REPO, "scan", "survey"),
            ai("Atticus.ScanVerify", "atticus.scanverify", StepTarget.REPO, "scan", "verify"),
            ai("Atticus.DraftSpec", "atticus.spec", StepTarget.REPO, "spec", "draft"),
            // VS Code has the same step twice: in the palette and on a repo's row.
            ai("Atticus.DraftSpec", "atticus.draftSpec", StepTarget.REPO, "spec", "draft"),
            ai("Atticus.Feature", "atticus.feature", StepTarget.CHANGE, "change", "feature"),
            ai("Atticus.Architecture", "atticus.architecture", StepTarget.CHANGE, "change", "architecture"),
            ai("Atticus.Stories", "atticus.stories", StepTarget.CHANGE, "plan", "stories"),
            ai("Atticus.SmallChange", "atticus.small", StepTarget.CHANGE, "change", "small"),
            ai("Atticus.Critic", "atticus.critic", StepTarget.CHANGE, "critic"),
            ai("Atticus.KnowledgeScan", "atticus.knowledgeScan", StepTarget.NONE, "knowledge", "scan"),
            ai("Atticus.AskKnowledge", "atticus.knowledgeAsk", StepTarget.NONE, "knowledge", "ask"),
            ai("Atticus.FindNeeds", "atticus.findNeeds", StepTarget.CHANGE, "change", "needs"),
            // ADR 0101: a question about one knowledge item, asked of the knowledge.
            ai("Atticus.AskAboutItem", "atticus.askAboutItem", StepTarget.NONE, "knowledge", "ask"),
        )

    /**
     * The commands Atticus runs itself, each with an action of its own. A shared write still goes
     * through the dry run and the person's yes (ADR 0099); nothing here changes that.
     */
    val COMMANDS: List<NativeStep> =
        listOf(
            // ADR 0124: the facts checked against the code. No model runs.
            cmd("Atticus.VerifyFacts", "atticus.verify", StepTarget.REPO, "verify"),
            // ADR 0128: what a repo is, in a person's words.
            cmd("Atticus.DescribeRepo", "atticus.describeRepo", StepTarget.REPO, "repo", "describe"),
            cmd("Atticus.AskCatalog", "atticus.ask", StepTarget.NONE, "ask"),
            cmd("Atticus.ScanAll", "atticus.scanAll", StepTarget.NONE, "scan"),
            cmd("Atticus.EstateJoin", "atticus.estateJoin", StepTarget.NONE, "estate", "join"),
            cmd("Atticus.WorkspaceSync", "atticus.workspaceSync", StepTarget.NONE, "workspace", "sync"),
            cmd("Atticus.SyncSources", "atticus.sourcesSync", StepTarget.NONE, "sources", "sync"),
            cmd("Atticus.Upgrade", "atticus.upgrade", StepTarget.NONE, "upgrade"),
            cmd("Atticus.CheckHealth", "atticus.checkHealth", StepTarget.NONE, "doctor"),
            cmd("Atticus.Digest", "atticus.digest", StepTarget.NONE, "digest"),
            cmd("Atticus.AddRepos", "atticus.addRepos", StepTarget.NONE, "repos", "discover"),
            cmd("Atticus.BringIn", "atticus.absorb", StepTarget.NONE, "absorb"),
            cmd("Atticus.AcceptBroughtIn", "atticus.absorbAccept", StepTarget.NONE, "absorb", "accept"),
            cmd("Atticus.OnboardRepo", "atticus.onboardRepo", StepTarget.REPO, "onboard"),
            cmd("Atticus.AddWiki", "atticus.addWiki", StepTarget.NONE, "sources", "add"),
            // The catalog as the baseline changes are checked against.
            cmd("Atticus.AcceptCatalog", "atticus.acceptCatalog", StepTarget.NONE, "baseline"),
            cmd("Atticus.DraftOrgPack", "atticus.draftOrgPack", StepTarget.NONE, "orgpack", "draft"),
            cmd("Atticus.OrgPackOwner", "atticus.openOrgPackOwner", StepTarget.NONE, "orgpack", "owner"),
            cmd("Atticus.ShowManualStep", "atticus.showManualStep", StepTarget.NONE, "todo", "show"),
            // ADR 0101: a knowledge item reviewed, from the Knowledge tab's row.
            cmd("Atticus.VerifyItem", "atticus.verifyItem", StepTarget.NONE, "knowledge", "verify"),
            cmd("Atticus.CorrectItem", "atticus.correctItem", StepTarget.NONE, "knowledge", "correct"),
            cmd("Atticus.RejectItem", "atticus.rejectItem", StepTarget.NONE, "knowledge", "reject"),
            cmd("Atticus.SyncSource", "atticus.syncSource", StepTarget.NONE, "sources", "sync"),
            cmd("Atticus.TagSource", "atticus.tagSource", StepTarget.NONE, "sources", "tag"),
            cmd("Atticus.NeedDone", "atticus.needDone", StepTarget.NONE, "needs", "done"),
            cmd("Atticus.NeedSkip", "atticus.needSkip", StepTarget.NONE, "needs", "skip"),
            cmd("Atticus.NeedReopen", "atticus.needReopen", StepTarget.NONE, "needs", "reopen"),
            cmd("Atticus.RunTask", "atticus.runTask", StepTarget.NONE, "task", "run"),
        )

    /** A source read into knowledge: an AI step on one source (`atticus knowledge scan --source`). */
    val READ_SOURCE = ai("Atticus.ReadSource", "atticus.readSource", StepTarget.NONE, "knowledge", "scan")

    val ALL: List<NativeStep> = AI + COMMANDS + READ_SOURCE

    private val BY_ACTION = ALL.associateBy { it.actionId }

    /** The step an action id does; null when the action is one of the plugin's own. */
    fun of(actionId: String): NativeStep? = BY_ACTION[actionId]

    /** Every action id a step names, once each. */
    val ACTION_IDS: List<String> = ALL.map { it.actionId }.distinct()

    /** The step class a step's runs go to the model as (ADR 0121 addendum), for the hand-off text. */
    fun classOf(s: NativeStep): StepClass? = StepModels.classOf(s.argv("x"))
}
