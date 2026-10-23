import { parseArgs } from "node:util";
import { createLog, SCHEMA_VERSION, orgPackDirOf } from "@maycombhq/core";
import { gitUser } from "@maycombhq/workspace";
import { basename, join, resolve } from "node:path";
import { type Output } from "./commands.js";
import { AiOffError, runtimeForCli, RuntimeConfigError, type AiRuntime } from "@maycombhq/ai";
import { registerBuiltInModelProviders } from "@maycombhq/model-providers";
import { existsSync } from "node:fs";

import { VERSION } from "./version.js";

/**
 * Command modules load when their command runs, not at start: loading all of them took most
 * of the CLI's start time (A2). Each wrapper has the same signature as the function it loads.
 */
const loadCommands = () => import("./commands.js");
const catalogValidate: typeof import("./commands.js").catalogValidate = (...a) =>
  loadCommands().then((m) => m.catalogValidate(...a));
const orgPackValidate: typeof import("./commands.js").orgPackValidate = (...a) =>
  loadCommands().then((m) => m.orgPackValidate(...a));
const schemaExport: typeof import("./commands.js").schemaExport = (...a) =>
  loadCommands().then((m) => m.schemaExport(...a));
const loadWorkspaceCommands = () => import("./workspace-commands.js");
const handoffDone: typeof import("./workspace-commands.js").handoffDone = (...a) =>
  loadWorkspaceCommands().then((m) => m.handoffDone(...a));
const openspecCheck: typeof import("./workspace-commands.js").openspecCheck = (...a) =>
  loadWorkspaceCommands().then((m) => m.openspecCheck(...a));
const openspecSetup: typeof import("./workspace-commands.js").openspecSetup = (...a) =>
  loadWorkspaceCommands().then((m) => m.openspecSetup(...a));
const workspaceOpen: typeof import("./workspace-commands.js").workspaceOpen = (...a) =>
  loadWorkspaceCommands().then((m) => m.workspaceOpen(...a));
const workspacePrune: typeof import("./workspace-commands.js").workspacePrune = (...a) =>
  loadWorkspaceCommands().then((m) => m.workspacePrune(...a));
const workspaceSync: typeof import("./workspace-commands.js").workspaceSync = (...a) =>
  loadWorkspaceCommands().then((m) => m.workspaceSync(...a));
const loadScanCommands = () => import("./scan-commands.js");
const catalogDiff: typeof import("./scan-commands.js").catalogDiff = (...a) =>
  loadScanCommands().then((m) => m.catalogDiff(...a));
const scanCommand: typeof import("./scan-commands.js").scanCommand = (...a) =>
  loadScanCommands().then((m) => m.scanCommand(...a));
const loadIndexCommands = () => import("./index-commands.js");
const askCommand: typeof import("./index-commands.js").askCommand = (...a) =>
  loadIndexCommands().then((m) => m.askCommand(...a));
const impactCommand: typeof import("./index-commands.js").impactCommand = (...a) =>
  loadIndexCommands().then((m) => m.impactCommand(...a));
const indexRebuild: typeof import("./index-commands.js").indexRebuild = (...a) =>
  loadIndexCommands().then((m) => m.indexRebuild(...a));
const queryCommand: typeof import("./index-commands.js").queryCommand = (...a) =>
  loadIndexCommands().then((m) => m.queryCommand(...a));
const loadSiteCommands = () => import("./site-commands.js");
const guideCommand: typeof import("./site-commands.js").guideCommand = (...a) =>
  loadSiteCommands().then((m) => m.guideCommand(...a));
const siteBuildCommand: typeof import("./site-commands.js").siteBuildCommand = (...a) =>
  loadSiteCommands().then((m) => m.siteBuildCommand(...a));
const loadBaselineCommands = () => import("./baseline-commands.js");
const baselineCommand: typeof import("./baseline-commands.js").baselineCommand = (...a) =>
  loadBaselineCommands().then((m) => m.baselineCommand(...a));
const setupCommand: typeof import("./baseline-commands.js").setupCommand = (...a) =>
  loadBaselineCommands().then((m) => m.setupCommand(...a));
const loadDigestCommands = () => import("./digest-commands.js");
const digestCommand: typeof import("./digest-commands.js").digestCommand = (...a) =>
  loadDigestCommands().then((m) => m.digestCommand(...a));
const loadDoctor = () => import("./doctor.js");
const doctorCommand: typeof import("./doctor.js").doctorCommand = (...a) =>
  loadDoctor().then((m) => m.doctorCommand(...a));
const loadSupport = () => import("./support.js");
const supportBundleCommand: typeof import("./support.js").supportBundleCommand = (...a) =>
  loadSupport().then((m) => m.supportBundleCommand(...a));
const loadUpgrade = () => import("./upgrade.js");
const upgradeCommand: typeof import("./upgrade.js").upgradeCommand = (...a) =>
  loadUpgrade().then((m) => m.upgradeCommand(...a));
const loadReconcileCommands = () => import("./reconcile-commands.js");
const aliasCommand: typeof import("./reconcile-commands.js").aliasCommand = (...a) =>
  loadReconcileCommands().then((m) => m.aliasCommand(...a));
const reconcileCommand: typeof import("./reconcile-commands.js").reconcileCommand = (...a) =>
  loadReconcileCommands().then((m) => m.reconcileCommand(...a));
const loadKnowledgeCommands = () => import("./knowledge-commands.js");
const coverageCommand: typeof import("./knowledge-commands.js").coverageCommand = (...a) =>
  loadKnowledgeCommands().then((m) => m.coverageCommand(...a));
const patternsScan: typeof import("./knowledge-commands.js").patternsScan = (...a) =>
  loadKnowledgeCommands().then((m) => m.patternsScan(...a));
const questionsCommand: typeof import("./knowledge-commands.js").questionsCommand = (...a) =>
  loadKnowledgeCommands().then((m) => m.questionsCommand(...a));
const questionsFiles: typeof import("./question-commands.js").questionsFiles = (...a) =>
  import("./question-commands.js").then((m) => m.questionsFiles(...a));
const sourcesAdd: typeof import("./knowledge-commands.js").sourcesAdd = (...a) =>
  loadKnowledgeCommands().then((m) => m.sourcesAdd(...a));
const sourcesSync: typeof import("./knowledge-commands.js").sourcesSync = (...a) =>
  loadKnowledgeCommands().then((m) => m.sourcesSync(...a));
const loadDiagramCommands = () => import("./diagram-commands.js");
const diagramLibrary: typeof import("./diagram-commands.js").diagramLibrary = (...a) =>
  loadDiagramCommands().then((m) => m.diagramLibrary(...a));
const diagramRender: typeof import("./diagram-commands.js").diagramRender = (...a) =>
  loadDiagramCommands().then((m) => m.diagramRender(...a));
const loadStubCommands = () => import("./stub-commands.js");
const stubCheck: typeof import("./stub-commands.js").stubCheck = (...a) =>
  loadStubCommands().then((m) => m.stubCheck(...a));
const stubServe: typeof import("./stub-commands.js").stubServe = (...a) =>
  loadStubCommands().then((m) => m.stubServe(...a));
const loadIntakeCommands = () => import("./intake-commands.js");
const intakeAdd: typeof import("./intake-commands.js").intakeAdd = (...a) =>
  loadIntakeCommands().then((m) => m.intakeAdd(...a));
const intakeList: typeof import("./intake-commands.js").intakeList = (...a) =>
  loadIntakeCommands().then((m) => m.intakeList(...a));
const triageDecide: typeof import("./intake-commands.js").triageDecide = (...a) =>
  loadIntakeCommands().then((m) => m.triageDecide(...a));
const triageList: typeof import("./intake-commands.js").triageList = (...a) =>
  loadIntakeCommands().then((m) => m.triageList(...a));
const loadRunCommands = () => import("./run-commands.js");
const assistantFiles: typeof import("./run-commands.js").assistantFiles = (...a) =>
  loadRunCommands().then((m) => m.assistantFiles(...a));
const driftCommand: typeof import("./run-commands.js").driftCommand = (...a) =>
  loadRunCommands().then((m) => m.driftCommand(...a));
const specHandDown: typeof import("./run-commands.js").specHandDown = (...a) =>
  loadRunCommands().then((m) => m.specHandDown(...a));
const specHandUp: typeof import("./run-commands.js").specHandUp = (...a) =>
  loadRunCommands().then((m) => m.specHandUp(...a));
const taskHandoff: typeof import("./run-commands.js").taskHandoff = (...a) =>
  loadRunCommands().then((m) => m.taskHandoff(...a));
const taskRun: typeof import("./run-commands.js").taskRun = (...a) =>
  loadRunCommands().then((m) => m.taskRun(...a));
const loadFeatureCommands = () => import("./feature-commands.js");
const featureSuggestNames: typeof import("./feature-commands.js").featureSuggestNames = (...a) =>
  loadFeatureCommands().then((m) => m.featureSuggestNames(...a));
const loadDomainCommands = () => import("./domain-commands.js");
const domainProfileCommand: typeof import("./domain-commands.js").domainProfileCommand = (...a) =>
  loadDomainCommands().then((m) => m.domainProfileCommand(...a));
const loadPlanCommands = () => import("./plan-commands.js");
const adoSync: typeof import("./plan-commands.js").adoSync = (...a) =>
  loadPlanCommands().then((m) => m.adoSync(...a));
const changeDraft: typeof import("./plan-commands.js").changeDraft = (...a) =>
  loadPlanCommands().then((m) => m.changeDraft(...a));
const planStories: typeof import("./plan-commands.js").planStories = (...a) =>
  loadPlanCommands().then((m) => m.planStories(...a));
const snowDraft: typeof import("./plan-commands.js").snowDraft = (...a) =>
  loadPlanCommands().then((m) => m.snowDraft(...a));
const snowSubmit: typeof import("./plan-commands.js").snowSubmit = (...a) =>
  loadPlanCommands().then((m) => m.snowSubmit(...a));
const storyBarCommand: typeof import("./plan-commands.js").storyBarCommand = (...a) =>
  loadPlanCommands().then((m) => m.storyBarCommand(...a));
const templatesDraft: typeof import("./plan-commands.js").templatesDraft = (...a) =>
  loadPlanCommands().then((m) => m.templatesDraft(...a));
const loadTodoCommands = () => import("./todo-commands.js");
const executorsCheck: typeof import("./todo-commands.js").executorsCheck = (...a) =>
  loadTodoCommands().then((m) => m.executorsCheck(...a));
const todoDone: typeof import("./todo-commands.js").todoDone = (...a) =>
  loadTodoCommands().then((m) => m.todoDone(...a));
const todoList: typeof import("./todo-commands.js").todoList = (...a) =>
  loadTodoCommands().then((m) => m.todoList(...a));
const todoRun: typeof import("./todo-commands.js").todoRun = (...a) =>
  loadTodoCommands().then((m) => m.todoRun(...a));
const todoShow: typeof import("./todo-commands.js").todoShow = (...a) =>
  loadTodoCommands().then((m) => m.todoShow(...a));
const loadSetupCommands = () => import("./setup-commands.js");
const absorbCommand: typeof import("./setup-commands.js").absorbCommand = (...a) =>
  loadSetupCommands().then((m) => m.absorbCommand(...a));
const absorbAcceptCommand: typeof import("./setup-commands.js").absorbAcceptCommand = (...a) =>
  loadSetupCommands().then((m) => m.absorbAcceptCommand(...a));
const absorbRefreshCommand: typeof import("./setup-commands.js").absorbRefreshCommand = (...a) =>
  loadSetupCommands().then((m) => m.absorbRefreshCommand(...a));
const sourcesRefreshCommand: typeof import("./setup-commands.js").sourcesRefreshCommand = (...a) =>
  loadSetupCommands().then((m) => m.sourcesRefreshCommand(...a));
const adoptCommand: typeof import("./setup-commands.js").adoptCommand = (...a) =>
  loadSetupCommands().then((m) => m.adoptCommand(...a));
const initCommand: typeof import("./setup-commands.js").initCommand = (...a) =>
  loadSetupCommands().then((m) => m.initCommand(...a));
const reposDiscoverCommand: typeof import("./setup-commands.js").reposDiscoverCommand = (...a) =>
  loadSetupCommands().then((m) => m.reposDiscoverCommand(...a));
const unadoptCommand: typeof import("./setup-commands.js").unadoptCommand = (...a) =>
  loadSetupCommands().then((m) => m.unadoptCommand(...a));
const zeroInstallCommand: typeof import("./setup-commands.js").zeroInstallCommand = (...a) =>
  loadSetupCommands().then((m) => m.zeroInstallCommand(...a));
const loadQualityCommands = () => import("./quality-commands.js");
const ciArchiveGate: typeof import("./quality-commands.js").ciArchiveGate = (...a) =>
  loadQualityCommands().then((m) => m.ciArchiveGate(...a));
const ciDrift: typeof import("./quality-commands.js").ciDrift = (...a) =>
  loadQualityCommands().then((m) => m.ciDrift(...a));
const ciSnippet: typeof import("./quality-commands.js").ciSnippet = (...a) =>
  loadQualityCommands().then((m) => m.ciSnippet(...a));
const glossaryAlias: typeof import("./quality-commands.js").glossaryAlias = (...a) =>
  loadQualityCommands().then((m) => m.glossaryAlias(...a));
const glossaryDefine: typeof import("./quality-commands.js").glossaryDefine = (...a) =>
  loadQualityCommands().then((m) => m.glossaryDefine(...a));
const glossaryLink: typeof import("./quality-commands.js").glossaryLink = (...a) =>
  loadQualityCommands().then((m) => m.glossaryLink(...a));
const glossaryList: typeof import("./quality-commands.js").glossaryList = (...a) =>
  loadQualityCommands().then((m) => m.glossaryList(...a));
const glossaryScan: typeof import("./quality-commands.js").glossaryScan = (...a) =>
  loadQualityCommands().then((m) => m.glossaryScan(...a));
const testsGenerate: typeof import("./quality-commands.js").testsGenerate = (...a) =>
  loadQualityCommands().then((m) => m.testsGenerate(...a));
const traceCommand: typeof import("./quality-commands.js").traceCommand = (...a) =>
  loadQualityCommands().then((m) => m.traceCommand(...a));
const loadInitiativeCommands = () => import("./initiative-commands.js");
const initiativeCommitment: typeof import("./initiative-commands.js").initiativeCommitment = (
  ...a
) => loadInitiativeCommands().then((m) => m.initiativeCommitment(...a));
const initiativeNew: typeof import("./initiative-commands.js").initiativeNew = (...a) =>
  loadInitiativeCommands().then((m) => m.initiativeNew(...a));
const initiativePlan: typeof import("./initiative-commands.js").initiativePlan = (...a) =>
  loadInitiativeCommands().then((m) => m.initiativePlan(...a));
const initiativeStatus: typeof import("./initiative-commands.js").initiativeStatus = (...a) =>
  loadInitiativeCommands().then((m) => m.initiativeStatus(...a));
const requestFromTeam: typeof import("./initiative-commands.js").requestFromTeam = (...a) =>
  loadInitiativeCommands().then((m) => m.requestFromTeam(...a));
const loadLearnCommands = () => import("./learn-commands.js");
const explainCommand: typeof import("./learn-commands.js").explainCommand = (...a) =>
  loadLearnCommands().then((m) => m.explainCommand(...a));
const learnCheck: typeof import("./learn-commands.js").learnCheck = (...a) =>
  loadLearnCommands().then((m) => m.learnCheck(...a));
const learnList: typeof import("./learn-commands.js").learnList = (...a) =>
  loadLearnCommands().then((m) => m.learnList(...a));
const learnStart: typeof import("./learn-commands.js").learnStart = (...a) =>
  loadLearnCommands().then((m) => m.learnStart(...a));
const sandboxCreate: typeof import("./learn-commands.js").sandboxCreate = (...a) =>
  loadLearnCommands().then((m) => m.sandboxCreate(...a));
const loadEvalCommands = () => import("./eval-commands.js");
const loadBenchCommands = () => import("./bench-commands.js");
const benchFetch: typeof import("./bench-commands.js").benchFetch = (...a) =>
  loadBenchCommands().then((m) => m.benchFetch(...a));
const benchRun: typeof import("./bench-commands.js").benchRun = (...a) =>
  loadBenchCommands().then((m) => m.benchRun(...a));
const benchSurvey: typeof import("./bench-commands.js").benchSurvey = (...a) =>
  loadBenchCommands().then((m) => m.benchSurvey(...a));
const benchVerify: typeof import("./bench-commands.js").benchVerify = (...a) =>
  loadBenchCommands().then((m) => m.benchVerify(...a));
const loadScanVerifyCommands = () => import("./scan-verify-commands.js");
// ADR 0087: change feature|architecture, plan stories from target flows, bench design.
const stageCli: typeof import("./stage-commands.js").stageCli = (...a) =>
  import("./stage-commands.js").then((m) => m.stageCli(...a));
// ADR 0083: sources tag, knowledge scan|list|ask, bench knowledge.
const knowledgeCli: typeof import("./knowledge-scan-commands.js").knowledgeCli = (...a) =>
  import("./knowledge-scan-commands.js").then((m) => m.knowledgeCli(...a));
const defencesScan: typeof import("./eval-commands.js").defencesScan = (...a) =>
  loadEvalCommands().then((m) => m.defencesScan(...a));
const evalReport: typeof import("./eval-commands.js").evalReport = (...a) =>
  loadEvalCommands().then((m) => m.evalReport(...a));
const evalRun: typeof import("./eval-commands.js").evalRun = (...a) =>
  loadEvalCommands().then((m) => m.evalRun(...a));
const loadU1Commands = () => import("./u1-commands.js");
const conformanceCommand: typeof import("./u1-commands.js").conformanceCommand = (...a) =>
  loadU1Commands().then((m) => m.conformanceCommand(...a));
const loadReleaseCommands = () => import("./release-commands.js");
const outcomeList: typeof import("./release-commands.js").outcomeList = (...a) =>
  loadReleaseCommands().then((m) => m.outcomeList(...a));
const outcomeRecord: typeof import("./release-commands.js").outcomeRecord = (...a) =>
  loadReleaseCommands().then((m) => m.outcomeRecord(...a));
const releaseEvidenceCommand: typeof import("./release-commands.js").releaseEvidenceCommand = (
  ...a
) => loadReleaseCommands().then((m) => m.releaseEvidenceCommand(...a));
const releaseForecastCommand: typeof import("./release-commands.js").releaseForecastCommand = (
  ...a
) => loadReleaseCommands().then((m) => m.releaseForecastCommand(...a));
const releaseNotesCommand: typeof import("./release-commands.js").releaseNotesCommand = (...a) =>
  loadReleaseCommands().then((m) => m.releaseNotesCommand(...a));
const releasePlanCommand: typeof import("./release-commands.js").releasePlanCommand = (...a) =>
  loadReleaseCommands().then((m) => m.releasePlanCommand(...a));
const releaseSecurityCommand: typeof import("./release-commands.js").releaseSecurityCommand = (
  ...a
) => loadReleaseCommands().then((m) => m.releaseSecurityCommand(...a));
import type { McpRun } from "./mcp.js";
const loadUiCommands = () => import("./ui-commands.js");
const uiCommand: typeof import("./ui-commands.js").uiCommand = (...a) =>
  loadUiCommands().then((m) => m.uiCommand(...a));
const loadCriticCommands = () => import("./critic-commands.js");
const critic: typeof import("./critic-commands.js").critic = (...a) =>
  loadCriticCommands().then((m) => m.critic(...a));
const criticStats: typeof import("./critic-commands.js").criticStats = (...a) =>
  loadCriticCommands().then((m) => m.criticStats(...a));
const findingAction: typeof import("./critic-commands.js").findingAction = (...a) =>
  loadCriticCommands().then((m) => m.findingAction(...a));
const findings: typeof import("./critic-commands.js").findings = (...a) =>
  loadCriticCommands().then((m) => m.findings(...a));
const catalogMigrate: typeof import("./feature-commands.js").catalogMigrate = (...a) =>
  loadFeatureCommands().then((m) => m.catalogMigrate(...a));
const featureLink: typeof import("./feature-commands.js").featureLink = (...a) =>
  loadFeatureCommands().then((m) => m.featureLink(...a));
const featureList: typeof import("./feature-commands.js").featureList = (...a) =>
  loadFeatureCommands().then((m) => m.featureList(...a));
const featureMerge: typeof import("./feature-commands.js").featureMerge = (...a) =>
  loadFeatureCommands().then((m) => m.featureMerge(...a));
const featureName: typeof import("./feature-commands.js").featureName = (...a) =>
  loadFeatureCommands().then((m) => m.featureName(...a));
const featureShow: typeof import("./feature-commands.js").featureShow = (...a) =>
  loadFeatureCommands().then((m) => m.featureShow(...a));
const featureSpec: typeof import("./feature-commands.js").featureSpec = (...a) =>
  loadFeatureCommands().then((m) => m.featureSpec(...a));
const featureSplit: typeof import("./feature-commands.js").featureSplit = (...a) =>
  loadFeatureCommands().then((m) => m.featureSplit(...a));
const featureSuggestLinks: typeof import("./feature-commands.js").featureSuggestLinks = (...a) =>
  loadFeatureCommands().then((m) => m.featureSuggestLinks(...a));
const featureTag: typeof import("./feature-commands.js").featureTag = (...a) =>
  loadFeatureCommands().then((m) => m.featureTag(...a));
const loadChangeCommands = () => import("./change-commands.js");
const changeArchive: typeof import("./change-commands.js").changeArchive = (...a) =>
  loadChangeCommands().then((m) => m.changeArchive(...a));
const changeConflicts: typeof import("./change-commands.js").changeConflicts = (...a) =>
  loadChangeCommands().then((m) => m.changeConflicts(...a));
const changeHandoff: typeof import("./change-commands.js").changeHandoff = (...a) =>
  loadChangeCommands().then((m) => m.changeHandoff(...a));
const changeList: typeof import("./change-commands.js").changeList = (...a) =>
  loadChangeCommands().then((m) => m.changeList(...a));
const changeNew: typeof import("./change-commands.js").changeNew = (...a) =>
  loadChangeCommands().then((m) => m.changeNew(...a));
const changeReturn: typeof import("./change-commands.js").changeReturn = (...a) =>
  loadChangeCommands().then((m) => m.changeReturn(...a));
const changeStatus: typeof import("./change-commands.js").changeStatus = (...a) =>
  loadChangeCommands().then((m) => m.changeStatus(...a));
const changeSync: typeof import("./change-commands.js").changeSync = (...a) =>
  loadChangeCommands().then((m) => m.changeSync(...a));
const loadDialectCommands = () => import("./dialect-commands.js");
const dialectGrade: typeof import("./dialect-commands.js").dialectGrade = (...a) =>
  loadDialectCommands().then((m) => m.dialectGrade(...a));
const dialectKit: typeof import("./dialect-commands.js").dialectKit = (...a) =>
  loadDialectCommands().then((m) => m.dialectKit(...a));
const dialectTree: typeof import("./dialect-commands.js").dialectTree = (...a) =>
  loadDialectCommands().then((m) => m.dialectTree(...a));
const dialectNew: typeof import("./dialect-commands.js").dialectNew = (...a) =>
  loadDialectCommands().then((m) => m.dialectNew(...a));
const dialectRun: typeof import("./dialect-commands.js").dialectRun = (...a) =>
  loadDialectCommands().then((m) => m.dialectRun(...a));
const dialectTest: typeof import("./dialect-commands.js").dialectTest = (...a) =>
  loadDialectCommands().then((m) => m.dialectTest(...a));
const loadPluginCommands = () => import("./plugin-commands.js");
const pluginTest: typeof import("./plugin-commands.js").pluginTest = (...a) =>
  loadPluginCommands().then((m) => m.pluginTest(...a));
const pluginPin: typeof import("./plugin-commands.js").pluginPin = (...a) =>
  loadPluginCommands().then((m) => m.pluginPin(...a));
const loadFrameworkCommands = () => import("./framework-commands.js");
const frameworksCheck: typeof import("./framework-commands.js").frameworksCheck = (...a) =>
  loadFrameworkCommands().then((m) => m.frameworksCheck(...a));
const frameworksDiscover: typeof import("./framework-commands.js").frameworksDiscover = (...a) =>
  loadFrameworkCommands().then((m) => m.frameworksDiscover(...a));
const frameworksKit: typeof import("./framework-commands.js").frameworksKit = (...a) =>
  loadFrameworkCommands().then((m) => m.frameworksKit(...a));
const frameworksLearn: typeof import("./framework-commands.js").frameworksLearn = (...a) =>
  loadFrameworkCommands().then((m) => m.frameworksLearn(...a));
const frameworksSurvey: typeof import("./framework-commands.js").frameworksSurvey = (...a) =>
  loadFrameworkCommands().then((m) => m.frameworksSurvey(...a));
const loadOnboardCommands = () => import("./onboard-commands.js");
const onboardAccept: typeof import("./onboard-commands.js").onboardAccept = (...a) =>
  loadOnboardCommands().then((m) => m.onboardAccept(...a));
const onboardCheck: typeof import("./onboard-commands.js").onboardCheck = (...a) =>
  loadOnboardCommands().then((m) => m.onboardCheck(...a));
const onboardDraft: typeof import("./onboard-commands.js").onboardDraft = (...a) =>
  loadOnboardCommands().then((m) => m.onboardDraft(...a));
const scanReview: typeof import("./onboard-commands.js").scanReview = (...a) =>
  loadOnboardCommands().then((m) => m.scanReview(...a));
const scanSurvey: typeof import("./onboard-commands.js").scanSurvey = (...a) =>
  loadOnboardCommands().then((m) => m.scanSurvey(...a));
const loadRepoTypeCommands = () => import("./repo-type-commands.js");
const loadSpecCommands = () => import("./spec-commands.js");
const loadEstateCommands = () => import("./estate-commands.js");
const onboardEval: typeof import("./onboard-commands.js").onboardEval = (...a) =>
  loadOnboardCommands().then((m) => m.onboardEval(...a));
const onboardFramework: typeof import("./onboard-commands.js").onboardFramework = (...a) =>
  loadOnboardCommands().then((m) => m.onboardFramework(...a));
const onboardFrameworkAccept: typeof import("./onboard-commands.js").onboardFrameworkAccept = (
  ...a
) => loadOnboardCommands().then((m) => m.onboardFrameworkAccept(...a));
const onboardFrameworkCheck: typeof import("./onboard-commands.js").onboardFrameworkCheck = (
  ...a
) => loadOnboardCommands().then((m) => m.onboardFrameworkCheck(...a));

export { VERSION };

const HELP = `atticus ${VERSION} (catalog schema v${SCHEMA_VERSION})

Usage:
  atticus schema export [dir]          Write JSON Schema for every contract and the API's OpenAPI document (default: ./schema)
  atticus catalog validate <dir>       Check record files: schema, location and canonical form
          [--fix]                      Rewrite files that aren't in canonical form
  atticus catalog diff <a> <b>         Compare two catalog folders (exit 1 when they differ)
  atticus scan [--no-drift]            Scan every repo's base clone and write catalog/generated
          [--repos a,b]                Only these repos
          [--full]                     Ignore the scan cache
          [--dry-run]                  Show what would change; write nothing
          [--warnings]                 List what the scan left out or couldn't read, not just how many
          [--json]                     Print the result as JSON
  atticus scan survey <repo>           Your assistant reads the repo and drafts its scan settings (folders to leave out, path prefixes, client base URLs); checked against the code [--attempts 3] [--force]
  atticus scan verify <repo>           Your assistant compares the code with the last scan: what it missed, what it has wrong, a fix for each; checked, kept in proposals/scan/ [--attempts 3] [--json] [--accept]
  atticus spec draft <repo>            Your assistant writes the repo's flows, one per trigger, each step cited and checked [--attempts 3] [--resume run] [--force] [--mode m]
  atticus spec check <repo> [--json]   Check the repo's flows against the catalog, the template and the code; confirms steps on their cited lines
  atticus estate join [--json]         Join each repo's call-outs to the flows their targets start; writes specs/estate.yaml
  atticus estate flow <flow> [--depth 5] [--json]  A flow followed across repos, with the data at each crossing
  atticus estate lineage <flow> <field> [--depth 5] [--json]  Follow a field along a flow to the column it is stored in, or where it breaks
  atticus repo-type detect <repo> [--json]   Match a repo against the org pack's repo types by fingerprint, with the evidence for each signal
  atticus repo-type new <id> --from <repo> [--force]   Draft a repo type from a repo (its build files, dependencies, markers, folders) for you to edit
  atticus scan review <repo>           What the last scan couldn't read: your assistant gives a verdict on each gap and a rule for code it can read; checked [--gaps] [--attempts 3]
  atticus query "<query>"              Find records, e.g. "kind:interface via:gateway -has:pattern"
          [--limit n] [--json]         (see docs/query-language.md)
  atticus impact <id>                  What a change to a record reaches, with owners and open questions
  atticus ask "<question>"             Answer a plain question from the catalog, showing the query it ran
  atticus setup [--json]               The setup checklist until the catalog is accepted, with a fix for each step
  atticus baseline                     Accept the as-is catalog as the baseline [--note text] [--site dir]
  atticus doctor [--json]              Check this machine: Node, Git, OpenSpec, proxy, TLS, disk, port, assistant
  atticus upgrade [--check|--dry-run]  Bring the metarepo's files up to this version (backs them up first)
  atticus support bundle               Collect versions, checks, counts and the redacted log in a zip [--out f]
  atticus digest                       What waits on you: hand-offs to revise, blocking findings [--channel c] [--send] [--json]
  atticus guide <system> [--json]      A system's guide, generated from the catalog: parts, calls, data, runtime, decisions
  atticus site build <dir> [--title t]  The read-only catalog site as static files (only systems open to everyone)
          [--depth n] [--json]
  atticus index rebuild                Rebuild the local index from the catalog files
  atticus reconcile [diagram...]       Compare draw.io diagrams with the catalog (default: inputs/diagrams)
          [--json]
  atticus sources add <type> <location>  Print the sources.yaml entry for a wiki (git, markdown-folder, ado-wiki, ...), or write it [--save]
          [--id <id>] [--path <folder>] [--ref <branch>] [--submodule] [--kind <k,k>] [--framework <f,f>] [--owner <who>] [--save]
  atticus sources sync [--source s] [--json]  Read the wikis and copy each to a dated snapshot: pages, stale pages, conflicts with code, document-only facts
  atticus sources tag <source> [--kind k,k] [--framework f,f] [--owner o]  Tag a knowledge source in sources.yaml (kinds, frameworks, owner)
  atticus knowledge scan [--source s] [--mode m] [--resume run] [--full] [--batch-tokens n]  Your assistant reads the snapshots into patterns, standards, processes, requests, decisions and constraints; every quote checked. A rescan reads only the pages that changed and says what changed
  atticus knowledge list [--tag t] [--kind k] [--unverified] [--json]  The knowledge items, by tag and kind
  atticus knowledge ask "<question>" [--mode m] [--resume run]  An answer from the knowledge items only, citing them
  atticus knowledge find "<phrase>"   Search every wiki for a term or phrase; your assistant reads the pages that mention it and proposes what isn't a knowledge item yet, each quote checked [--source s] [--mode m] [--resume run] [--json]
  atticus knowledge keep <item>        Keep a found item as a knowledge item you verified [--find <search>] [--as <kind>] [--set <field=value>] [--note <text>]
  atticus knowledge finds [--json]     The searches saved, and how many of each were kept
  atticus knowledge verify <item>      Mark a knowledge item right as read: a green tick wherever it shows [--note <text>]
  atticus knowledge correct <item> --set field=value  Correct an item's details (a list takes a|b|c); the corrected item is what plans read [--note <text>]
  atticus knowledge reject <item> --note <why>  Mark an item wrong: plans and answers leave it out
  atticus bench knowledge [--mode m] [--resume run]  Scan the bench's invented wiki, ask its questions, and score both
  atticus bench design [--mode m] [--resume run]  Read the bench's Figma export, map it against the petclinic estate, and score it
  atticus sources refresh [--json]     Fetch every absorbed source again and show what changed
  atticus patterns scan [--json]       Find integration patterns in the wikis and compare them with the org pack
  atticus coverage [--json]            What the catalog knows per system and area: verified, document-only, unknown
  atticus questions [--json]           Knowledge gaps and the owner questions that close them
  atticus questions list [--state open] [--json]   The questions in questions/ a step raised for a person
  atticus questions answer <id> --option <n> | --text "..."   Write the answer to the file; prints the rerun
          [--scope repo|repo-type] [--type <repo type>] [--by who]
  atticus intake add <files...>        Drop documents, specs and diagrams into inputs/inbox for intake
  atticus intake list [--json]         What intake read from inputs/: kinds, systems, duplicates, versions
  atticus triage [--json]              What needs a person: unknown names, conflicts with code, image edges
  atticus triage decide <item> <n>     Choose option n for a triage item; writes a curated decision
          [--reason text]
  atticus diagram render <view|file>   Draw a view (context, container, data, event, sequence) or a .drawio file
          [--focus id] [--format mermaid|drawio] [--out file]
  atticus diagram library <file>       Write the draw.io shape library
  atticus stub serve <spec|id>         Serve a stub of an API from its spec, or from the catalog (--from-catalog)
          [--port 4010] [--host 127.0.0.1]
  atticus stub check <spec>            Which operations have examples to answer with
  atticus dialect new <name> --from <repo>[,<repo>...]   Scaffold a dialect from sample repos
  atticus dialect test <name>          Run a dialect's own tests
  atticus dialect run <name> <repo>    Show the records a dialect produces from one repo [--json]
  atticus dialect kit [dir]            Export the dialect build kit for an assistant
  atticus dialect tree <file> [--language l]   Print a file's syntax tree, for syntax matches
  atticus plugin test|pin <id>         Run a scanner plugin against its golden files, sandboxed; or pin its entry file's sha256
  atticus onboard <repo> [--name n] [--attempts 3] [--mode m]   Your assistant drafts a dialect for a repo Atticus can't read; checked, kept as a proposal
  atticus onboard check <name> --repo <repo>   Check a proposal (drafted, handed off or hand-written)
  atticus onboard eval <dir> [--mode m] [--json]   Score the assistant's drafts against reference dialects
  atticus onboard accept <name> [--replace]   Accept a proposal into org-pack/dialects/ (or frameworks/)
  atticus onboard framework <name> --from <source|jar|tgz> [--users <repo>,...]   Learn a house framework, your assistant drafts what the learner couldn't; checked, kept as a proposal
          [--attempts 3] [--package a.b] [--mode m] [--no-ai]
  atticus onboard check framework <name> [--from <source>] [--users <repo>,...]   Check a framework proposal (drafted, handed off or hand-written)
  atticus onboard accept framework <name> [--replace]   Accept a framework proposal into org-pack/frameworks/
  atticus frameworks learn <name> --from <repo|jar|tgz>   Learn what a house framework means from its source, JAR or npm package
          [--package a.b] [--dry-run]  (writes org-pack/frameworks/<name>.yaml)
  atticus frameworks discover --group <a.b|@scope>[,...]   The house artifacts and npm packages the repos build on, found here
          [--jars <dir>]... [--learn] [--json]   (.jar and .tgz folders, Maven and Gradle caches, node_modules; never downloads)
  atticus frameworks check [name]      Run each framework model's own tests; a failing model isn't used
  atticus frameworks survey [--package <prefix>[,...]]   How the repos use house frameworks, any language [--json]
  atticus frameworks kit [dir]         Export the framework-model kit for an assistant
  atticus change new "<title>"         Start a change from a template: --type <type>
  atticus domain profile <system>      A system as a domain profile, filled from the catalog [--out file]
  atticus change feature <change>      The feature stage: your assistant places the change on the estate's flows and features from the brief, stories or a design; checked and criticised every draft until done [--from-figma f.json] [--mode m] [--resume run] [--force]
  atticus change architecture <change>  The architecture stage: the target flows (steps added, changed or removed, with fields) as flow deltas; looped the same way [--mode m] [--resume run]
  atticus change draft <change>        Your assistant drafts the proposal, spec and interfaces from the brief and the catalog; checked [--attempts 3] [--force] [--mode m]
          [--template id] [--id id] [--owner role=a,b]... [--system id]...
  atticus change status <id> [--json]  State, next step, what blocks it, risk, the PR to merge and test kinds
  atticus change handoff <id> --approve  Open the phase's hand-off PR; merging it approves the gate [--repo]
                                       (without --approve: say what it would open, send nothing)
  atticus change sync <id> [--approve]   Read the hand-off PR; a merged PR moves the change on (--approve merges a ready one)
  atticus change return <id> --reason "<why>" --approve  Close the hand-off PR and return the change to the product owner
  atticus change archive <id> [--no-rescan]  Archive a released change and rescan its repos
  atticus change list [--json]         Every change and its state
  atticus change conflicts [--json]    Open changes that touch the same systems, records or repos
  atticus critic <change> [--gate g] [--lens l] [--mode m] [--json]  Review a change at a gate: rule checks, then AI lenses (--mode runs them)
  atticus critic <change> [--gate g] --resume  Read in the AI lens answers your assistant wrote (hand-off); handoff done does it per lens
  atticus critic stats [--json]        How often each rule's findings are dismissed or waived
  atticus findings <change> [--json]   The change's findings by gate and round
  atticus finding <change> <id> <action>  apply | edit-and-apply | not-relevant | waive | ask (recorded with you; reaches main with the hand-off PR)
          [--gate g] [--reason text] [--asked-of who] [--edit patch-file]
  atticus feature list [--json]        Features found in code, named by people or proposed by AI
  atticus feature show <id> [--json]   A feature's entry points, flow, owner, links and gaps
  atticus feature name <id> "<name>"   Confirm or correct a feature's name [--description] [--owner]
  atticus feature tag <id> <tags...>   Tag a feature
  atticus feature merge <into> <from...>  Merge features
  atticus feature split <id> <entry-points...>  Split entry points into another feature [--name] [--into]
  atticus feature link <id> <ref>      Link a work item or page, e.g. ado:1234 [--title]
  atticus feature suggest-links [--json]  Suggest links between features and work items
  atticus feature spec <id>            Draft an OpenSpec capability spec from a confirmed feature
  atticus catalog migrate [--dry-run]  Rewrite catalog files to the current schema version
  atticus task run <change> <task>     Run a task with AI [--level plan|draft|pr] [--mode m] [--approve]
  atticus spec hand-down <change> <task>  Create the task's Spec Kit feature in its repo [--force]
  atticus spec hand-up <change> <task>  Read the Spec Kit feature back at the PR [--pr n --pr-url url]
  atticus drift <change> [--json]      Compare design, repo plans and code
  atticus assistant-files [--repo id [--change id]] [--force] [--check]  Generate Copilot and Claude Code files
  atticus feature suggest-names [--mode m]  Ask AI to propose names for detected features
  atticus plan stories <change>        Write stories, stories.md and tasks.md from the approved design [--force] [--mode m] [--draft: before approval]
  atticus change needs <change>        Your assistant says what the change needs from the organisation (requests and processes to raise, standards to follow, teams and vendors to involve), for the change, a feature, flow, story or task; each checked against the change's own words [--mode m] [--resume run]
  atticus needs [--change id] [--all] [--json]  What changes need from the organisation, open ones first, with lead times and who handles each
  atticus waiting [--group change|kind] [--filter words] [--json]  What waits on you across every change: questions, open needs, manual steps, findings, knowledge to verify
  atticus runs [--change id] [--limit n] [--json]  The model runs: what Atticus asked a model, each round, and whether it was answered
  atticus runs show <run> [--json]     One run: its prompt, its answer and the problems handed back to it
  atticus needs done <change> <item>   Record a need as done, e.g. with the CTASK number as its note [--for <target>] [--note <text>]
  atticus needs skip <change> <item> --note <why>  Record a need as not needed, and why [--for <target>]
  atticus needs reopen <change> <item>  Open a need again [--for <target>]
                                       (with target flows: the stories stage, a task per changed step with its prompt, requests from knowledge)
  atticus plan snow <change>           Draft service-desk requests the change needs [--force]
  atticus plan bar <change>            Measure the story bar [--eval file]
  atticus plan submit <change>         File the drafted requests (a dry run until you add --approve)
  atticus ado sync <change>            Create or update work items (a dry run until you add --approve) [--epic id]
  atticus templates draft              Draft request and work-item templates from wikis, uploads and past tickets [--no-ai]
  atticus todo [--change id] [--all]   Manual steps waiting for a person
  atticus todo show <step> [--export text|csv|import]  A manual step: what to do, where, and what it needs
  atticus todo done <step>             Record a manual step's result [--result k=v]... [--skip --note why]
  atticus todo run <step> --with <executor>  Run a step with a team's own tool [--approve --inputs sha] [--fill-only]
  atticus executors check              Ping configured executors and show what each covers
  atticus init <folder> --platform <p>  Create a new metarepo named after the folder [--from pack] [--owner who]
  atticus adopt <path>                 Use Atticus in an existing repo; writes only .atticus/ [--platform p] [--name n]
  atticus unadopt <path>               Remove Atticus from an adopted repo, leaving it as it was
  atticus repos discover <folder> | --org <org>  Propose repos.manifest.yaml entries [--platform p] [--dry-run]
  atticus absorb <git-url|path> --id <id>  Translate another team's prompts, agents, checklists, OpenSpec, Spec Kit, TypeSpec or Atticus repo
          [--mode adopt|link|ignore] [--ref r] [--dry-run]
  atticus absorb --refresh <id>        Fetch an absorbed source again and update its proposal
  atticus absorb accept <id>           Copy what the reviewed proposal adopts into the org pack and add its sources.yaml entry [--replace] [--dry-run] [--json]
  atticus tests generate <change> <story>  Generate tests from a story [--framework id] [--force] [--check] [--mode m]
  atticus trace <change> [--json] [--csv] [--no-write]  Requirement → story → test → code → records → feature
  atticus release plan <change> [--json]  Deploy order across the repos, why, rollback per step, waits and release sections
  atticus release forecast <change> [--json]  Forecast ready-to-release day from lead times and the initiative's plan
  atticus release evidence <change> [--out dir] [--json]  The evidence pack for an approval board or an audit
  atticus release notes <change> [--audience business|technical] [--json]  Release notes from the brief, interfaces and data
  atticus release security <change> [--json]  Security review draft: auth, classifications, boundaries, vendors, secrets
  atticus outcome list [--change id] [--json]  The brief's success measures and the values recorded after release
  atticus outcome record <change> <measure> --value <v>  Record a measured outcome [--note text]
  atticus ci drift [repo] --catalog <path>  In a repo's pipeline: compare the repo with the committed catalog
          [--repo id] [--json [file]] [--junit file] [--summary file] [--warn-only]
  atticus ci snippet <github|azure|gitlab|jenkins> [--write dir]  Pipeline template for the drift check
  atticus ci archive-gate <change> [--drift file]...  Whether a change may be archived
  atticus glossary list|scan [--json]  Business terms from wikis, code and people
  atticus glossary define <term> "<definition>" [--owner team]  Define a business term, as you
  atticus glossary link <term> <record-id|schema#field>  Link a term to a catalog record or field
  atticus glossary alias <term> <name>...  Another name people use for a term
  atticus initiative new "<title>" --journey <j>  Start an initiative [--id] [--release YYYY-MM-DD] [--epic]
  atticus initiative plan <id> --target <system>  Plan its changes and commitments [--release d] [--system s]... [--dry-run]
  atticus initiative status <id>       Critical path, at-risk and slipped commitments
  atticus initiative request <id> <party>  Send a team a system card and track the reply [--system s]...
  atticus initiative commit <commitment> <open|at-risk|done|slipped>  Record a commitment's status
  atticus learn [list] | learn start <role|lesson> | learn check [--answer a] [--lesson l] [--step s]
                                       Lessons by role in a practice sandbox: list them, start one, check a step
  atticus sandbox create <dir>         A throwaway practice metarepo
  atticus commands [--json]            Every command as data: its arguments, options, area and how it runs (for an editor)
  atticus explain <id|command>         Explain a record, finding, change or command in plain words
  atticus eval run [--agent a]... [--mode mock|replay|live] [--runs n]  Evaluate AI agents
  atticus eval report                  The latest eval results and AI quality
  atticus bench fetch [--repo id] [--batch n] [--cache dir]  Clone the bench's public repos at their pinned commits
  atticus bench survey [--repo id] [--batch n] [--mode m]  Your assistant drafts each bench repo's scan settings; kept for later runs
  atticus bench verify [--repo id] [--batch n] [--mode m]  Your assistant verifies each bench repo's scan; kept for bench run to score
  atticus bench run [--repo id] [--batch n] [--estate e] [--json] [--specs]  Scan each bench repo and score it against its reference; --specs also scores drafted specs against bench/flows and scans each estate's repos together
  atticus defences scan [path] [--all]  Look for instructions hidden in documents and prompts
  atticus conformance <path> --kind <catalog|org-pack|dialect|plugin|executor>
                                       Check a catalog, org pack, dialect, plugin or executor against the spec
  atticus alias "<name>" <id>          Record that a name used in diagrams or documents means a catalog id
          [--reason text]
  atticus orgpack validate [dir]       Check an org pack against its schemas (default: <root>/org-pack)
  atticus orgpack draft                Draft the profile's systems from the knowledge items: the products and vendors the wikis name, with their aliases and owners, each citing its item [--platform <p>] [--json]
  atticus orgpack accept <platform>    Put the drafted systems into profile.yaml [--only <id,id>] [--verified-only] [--dry-run] [--json]
  atticus openspec setup               Set up OpenSpec with the org-flow schema in the metarepo
  atticus openspec check               Check the OpenSpec version and validate every change and spec
  atticus handoff done <run-id>        Tell Atticus a hand-off artifact is written; it validates it
  atticus next [--all] [--json]        The next step to take, its command and slash command, and why; from the files only
  atticus <step> --handoff [--json]    On scan survey, scan verify, spec draft, knowledge scan, change feature, change architecture, change draft and plan stories: print only the prompt, the result file and the commands that finish it
  atticus workspace sync               Clone or update the base clone of every repo in the manifests
          [--repos a,b]                Only these repos
  atticus workspace open <change>      Create the change's worktrees, repos.yaml and editor workspaces
          --repos a,b                  The repos the change touches
  atticus workspace prune <change>     Remove worktrees whose PRs merged or closed
          [--all] [--force]            All worktrees; also those with uncommitted work

  --root <dir>                         The metarepo (default: the current folder)
  --by <handle>                        Who is acting (default: the metarepo's Git user, git config user.email)
  atticus mcp                          Serve read-only tools to an assistant over MCP (stdio): next step, catalog, knowledge, changes, needs (the Claude Code plugin starts it)
  atticus ui [--port n] [--open]       Start the app on this machine (127.0.0.1); Ctrl+C stops it
          [--embed vscode]             Let a VS Code panel show the app (the Atticus extension starts it so)
          [--parent pid]               Stop when that process ends (an editor that started it)
  atticus --version                    Print the version
  atticus --help                       Show this help

Every command is described in docs/guide/commands.md; atticus explain <command> says more.`;

/** Command groups whose commands record who did something (`by`), so they need the person. */
const RECORDS_A_PERSON = new Set([
  "knowledge",
  "needs",
  "upgrade",
  "baseline",
  "digest",
  "alias",
  "initiative",
  "outcome",
  "glossary",
  "plan",
  "ado",
  "todo",
  "task",
  "spec",
  "feature",
  "finding",
  "change",
  "triage",
  "handoff",
]);

/** A positive whole number from an option, or undefined. */
function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Run the CLI. Returns the process exit code: 0 ok, 1 problems found, 2 usage error. */
/**
 * Run `atticus <argv>`. What ran, how it ended and how long it took go to the metarepo's local
 * log (ADR 0050): the command and its flag names, never their values. A crash is logged with
 * its stack and rethrown, carrying the log's path for the message the person sees.
 */
export async function main(
  argv: string[],
  io: Output,
  o: { quiet?: boolean } = {},
): Promise<number> {
  const started = Date.now();
  // runtime.yaml adapters.model.type anthropic, openai-compatible, azure-openai and bedrock work
  // out of the box (ADR 0065); every command that builds a runtime finds them registered.
  registerBuiltInModelProviders();
  const words = argv.filter((a) => !a.startsWith("-")).slice(0, 2);
  const flags = [
    ...new Set(argv.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")[0]!)),
  ];
  const rootAt = argv.indexOf("--root");
  const root = resolve(rootAt >= 0 && argv[rootAt + 1] ? argv[rootAt + 1]! : process.cwd());
  const log = () =>
    isMetarepoRoot(root) ? createLog(root, o.quiet ? { level: "warn" } : {}) : undefined;
  try {
    const code = await dispatch(argv, io);
    log()?.info("command", { command: words.join(" "), flags, code, ms: Date.now() - started });
    return code;
  } catch (e) {
    const l = log();
    l?.error("crash", e, { command: words.join(" "), flags, ms: Date.now() - started });
    if (l && e instanceof Error) (e as Error & { logFile?: string }).logFile = l.file;
    throw e;
  }
}

/** A metarepo, or a repo adopted in place: where Atticus keeps a log. */
function isMetarepoRoot(root: string): boolean {
  return existsSync(join(root, "org-pack")) || existsSync(join(root, ".atticus", "org-pack"));
}

async function dispatch(argv: string[], io: Output): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      fix: { type: "boolean" },
      root: { type: "string" },
      repos: { type: "string" },
      all: { type: "boolean" },
      kind: { type: "string" },
      executor: { type: "string" },
      fixture: { type: "string" },
      force: { type: "boolean" },
      draft: { type: "boolean" },
      gaps: { type: "boolean" },
      full: { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      limit: { type: "string" },
      filter: { type: "string" },
      "batch-tokens": { type: "string" },
      depth: { type: "string" },
      by: { type: "string" },
      as: { type: "string" },
      group: { type: "string", multiple: true },
      channel: { type: "string" },
      send: { type: "boolean" },
      site: { type: "string" },
      reason: { type: "string" },
      focus: { type: "string" },
      format: { type: "string" },
      out: { type: "string" },
      port: { type: "string" },
      open: { type: "boolean" },
      embed: { type: "string" },
      parent: { type: "string" },
      host: { type: "string" },
      catalog: { type: "string" },
      "from-catalog": { type: "boolean" },
      from: { type: "string" },
      package: { type: "string" },
      jars: { type: "string", multiple: true },
      learn: { type: "boolean" },
      type: { type: "string" },
      template: { type: "string" },
      id: { type: "string" },
      owner: { type: "string", multiple: true },
      system: { type: "string", multiple: true },
      base: { type: "string" },
      repo: { type: "string" },
      gate: { type: "string" },
      lens: { type: "string" },
      "asked-of": { type: "string" },
      edit: { type: "string" },
      description: { type: "string" },
      title: { type: "string" },
      name: { type: "string" },
      attempts: { type: "string" },
      users: { type: "string" },
      language: { type: "string" },
      replace: { type: "boolean" },
      into: { type: "string" },
      level: { type: "string" },
      mode: { type: "string" },
      approve: { type: "boolean" },
      pr: { type: "string" },
      "pr-url": { type: "string" },
      change: { type: "string" },
      check: { type: "boolean" },
      resume: { type: "string" },
      eval: { type: "string" },
      epic: { type: "string" },
      "no-ai": { type: "boolean" },
      "no-drift": { type: "boolean" },
      warnings: { type: "boolean" },
      "no-rescan": { type: "boolean" },
      refresh: { type: "string" },
      export: { type: "string" },
      result: { type: "string", multiple: true },
      skip: { type: "boolean" },
      note: { type: "string" },
      for: { type: "string" },
      with: { type: "string" },
      inputs: { type: "string" },
      "fill-only": { type: "boolean" },
      platform: { type: "string" },
      ref: { type: "string" },
      org: { type: "string" },
      framework: { type: "string" },
      csv: { type: "boolean" },
      "no-write": { type: "boolean" },
      junit: { type: "string" },
      summary: { type: "string" },
      "json-out": { type: "string" },
      "warn-only": { type: "boolean" },
      write: { type: "string" },
      path: { type: "string" },
      submodule: { type: "boolean" },
      save: { type: "boolean" },
      only: { type: "string" },
      "verified-only": { type: "boolean" },
      unverified: { type: "boolean" },
      set: { type: "string", multiple: true },
      find: { type: "string" },
      drift: { type: "string", multiple: true },
      journey: { type: "string" },
      release: { type: "string" },
      target: { type: "string" },
      answer: { type: "string" },
      lesson: { type: "string" },
      step: { type: "string" },
      agent: { type: "string", multiple: true },
      runs: { type: "string" },
      audience: { type: "string" },
      value: { type: "string" },
      bench: { type: "string" },
      cache: { type: "string" },
      batch: { type: "string" },
      specs: { type: "boolean" },
      estate: { type: "string" },
      accept: { type: "boolean" },
      tag: { type: "string" },
      source: { type: "string" },
      "from-figma": { type: "string" },
    },
    strict: false,
  });

  if (values.version) {
    io.out(VERSION);
    return 0;
  }
  const [group, command, arg] = positionals;
  if (values.help || !group) {
    io.out(HELP);
    return 0;
  }
  // ADR 0096: every command as data, for an editor.
  if (group === "commands") {
    const { AREAS, commandCatalog } = await import("./command-catalog.js");
    const commands = commandCatalog(HELP);
    if (values.json === true) io.out(JSON.stringify({ areas: AREAS, commands }, null, 2));
    else
      for (const a of AREAS) {
        io.out(`${a.title}:`);
        for (const c of commands.filter((x) => x.area === a.id))
          io.out(`  atticus ${c.id}${c.runs === "local" ? "" : `  (${c.runs})`}`);
      }
    return 0;
  }
  if (group === "schema" && command === "export") {
    await schemaExport(arg ?? "schema", io);
    return 0;
  }
  if (group === "catalog" && command === "validate") {
    if (!arg) {
      io.err(
        "catalog validate needs a folder, for example: atticus catalog validate catalog/generated",
      );
      return 2;
    }
    const s = await catalogValidate(arg, { fix: values.fix === true }, io);
    return s.invalid + s.misplaced + s.notCanonical > 0 ? 1 : 0;
  }
  if (group === "catalog" && command === "diff") {
    const b = positionals[3];
    if (!arg || !b) {
      io.err(
        "catalog diff needs two folders, for example: atticus catalog diff catalog/generated /tmp/other",
      );
      return 2;
    }
    return catalogDiff(resolve(arg), resolve(b), values.json === true, io);
  }
  const root = resolve(typeof values.root === "string" ? values.root : process.cwd());
  // ADR 0086: atticus next, and --handoff on the AI steps (the prompt, result file and finish).
  if (group === "next" || values.handoff === true) {
    const h = await import("./handoff-flag.js");
    if (group === "next")
      return (await import("./next-commands.js")).nextCommand(
        root,
        { json: values.json === true, all: values.all === true },
        io,
      );
    if (h.isHandoffStep(group, command)) return h.handoffStep(root, argv, io, dispatch);
  }
  // Who is acting (ADR 0073): --by when given, else the metarepo's Git user, read once for the
  // commands that record a person. A fallback to the OS user is said once, on stderr, when used.
  const given = typeof values.by === "string" && values.by.trim() ? values.by : undefined;
  const person = !given && RECORDS_A_PERSON.has(group) ? await gitUser(root) : undefined;
  let warned = false;
  const who = (): string => {
    if (given) return given;
    if (person?.warning && !warned) {
      io.err(person.warning);
      warned = true;
    }
    return person?.handle ?? "someone";
  };
  const repoIds =
    typeof values.repos === "string"
      ? values.repos
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  // ADR 0101: what a change needs from the organisation, and a person's record of each.
  if ((group === "change" && command === "needs") || group === "needs") {
    const handled = await (
      await import("./needs-commands.js")
    ).needsCli(root, positionals, values, io, who);
    if (handled !== undefined) return handled;
  }
  // ADR 0105 and 0106: what waits on a person, and what Atticus asked a model.
  if (group === "waiting") {
    // --group repeats for repos discover; waiting takes one.
    const given = Array.isArray(values.group) ? values.group[0] : values.group;
    const g = given === undefined ? "change" : String(given);
    if (g !== "change" && g !== "kind") {
      io.err(`--group takes change or kind, not ${g}.`);
      return 2;
    }
    const run = async (argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(
        [...argv, "--root", root],
        { out: (l) => out.push(l), err: (l) => err.push(l) },
        { quiet: true },
      );
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    return (await import("./waiting-commands.js")).waitingCli(
      {
        by: g,
        ...(typeof values.filter === "string" ? { filter: values.filter } : {}),
        json: values.json === true,
      },
      io,
      run,
    );
  }
  if (group === "runs") {
    const m = await import("./runs-commands.js");
    if (command === "show") {
      const id = positionals[2];
      if (!id) {
        io.err("Usage: atticus runs show <run> [--json] (atticus runs lists them)");
        return 2;
      }
      return m.runShowCli(root, id, { json: values.json === true }, io);
    }
    if (command !== undefined) {
      io.err(`runs takes show <run>, or nothing to list them; not ${command}.`);
      return 2;
    }
    const limit = num(values.limit);
    return m.runsCli(
      root,
      {
        ...(typeof values.change === "string" ? { change: values.change } : {}),
        ...(limit ? { limit } : {}),
        json: values.json === true,
      },
      io,
    );
  }
  // ADR 0087: the change lifecycle's stages as loops, and the design bench.
  if (
    (group === "change" && (command === "feature" || command === "architecture")) ||
    (group === "plan" && command === "stories") ||
    (group === "bench" && command === "design")
  ) {
    const handled = await stageCli(root, positionals, values, io);
    if (handled !== undefined) return handled;
  }
  if (group === "repo-type" && (command === "detect" || command === "new")) {
    const m = await loadRepoTypeCommands();
    const from = typeof values.from === "string" ? values.from : undefined;
    if (command === "new")
      return m.repoTypeNew(
        root,
        arg ?? "",
        { ...(from ? { from } : {}), force: values.force === true },
        io,
      );
    if (!arg) {
      io.err("Usage: atticus repo-type detect <repo> [--json]");
      return 2;
    }
    return m.repoTypeDetect(root, arg, { json: values.json === true }, io);
  }
  if (group === "scan" && command === "survey") {
    const text = (v: unknown) => (typeof v === "string" ? v : undefined);
    if (!arg) {
      io.err(
        "Usage: atticus scan survey <repo> [--attempts 3] [--resume run] [--force] [--mode m]",
      );
      return 2;
    }
    const attempts = Number(text(values.attempts) ?? "3");
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
      io.err("--attempts is a whole number from 1 to 10.");
      return 2;
    }
    try {
      const { runtime } = await runtimeForCli(root, {
        ...(text(values.mode) ? { mode: text(values.mode)! } : {}),
      });
      return await scanSurvey(
        root,
        arg,
        {
          attempts,
          force: values.force === true,
          ...(text(values.resume) ? { resume: text(values.resume)! } : {}),
        },
        { runtime },
        io,
      );
    } catch (e) {
      if (e instanceof RuntimeConfigError) {
        io.err(e.message);
        return 2;
      }
      throw e;
    }
  }
  if (group === "estate" && (command === "join" || command === "flow" || command === "lineage")) {
    const m = await loadEstateCommands();
    const field = positionals[3];
    const depth = num(values.depth);
    const o = { json: values.json === true, ...(depth ? { depth } : {}) };
    if (command === "join") return m.estateJoin(root, o, io);
    if (!arg || (command === "lineage" && !field)) {
      io.err(
        command === "flow"
          ? "Usage: atticus estate flow <flow-id> [--depth 5] [--json]"
          : "Usage: atticus estate lineage <flow-id> <field> [--depth 5] [--json]",
      );
      return 2;
    }
    return command === "flow"
      ? m.estateFlowCommand(root, arg, o, io)
      : m.estateLineage(root, arg, field!, o, io);
  }
  if (group === "spec" && (command === "draft" || command === "check")) {
    const text = (v: unknown) => (typeof v === "string" ? v : undefined);
    const m = await loadSpecCommands();
    if (!arg) {
      io.err(
        command === "draft"
          ? "Usage: atticus spec draft <repo> [--attempts 3] [--resume run] [--force] [--mode m]"
          : "Usage: atticus spec check <repo> [--json]",
      );
      return 2;
    }
    if (command === "check") return m.specCheck(root, arg, { json: values.json === true }, io);
    const attempts = Number(text(values.attempts) ?? "3");
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
      io.err("--attempts is a whole number from 1 to 10.");
      return 2;
    }
    try {
      const { runtime } = await runtimeForCli(root, {
        ...(text(values.mode) ? { mode: text(values.mode)! } : {}),
      });
      return await m.specDraft(
        root,
        arg,
        {
          attempts,
          force: values.force === true,
          ...(text(values.resume) ? { resume: text(values.resume)! } : {}),
        },
        { runtime },
        io,
      );
    } catch (e) {
      if (e instanceof RuntimeConfigError) {
        io.err(e.message);
        return 2;
      }
      throw e;
    }
  }
  if (group === "scan" && command === "verify") {
    const text = (v: unknown) => (typeof v === "string" ? v : undefined);
    if (!arg) {
      io.err(
        "Usage: atticus scan verify <repo> [--attempts 3] [--resume run] [--mode m] [--json] | --accept",
      );
      return 2;
    }
    const m = await loadScanVerifyCommands();
    if (values.accept === true) {
      const by = given ?? (await gitUser(root)).handle ?? "someone";
      return m.scanVerifyAccept(root, arg, { by }, io);
    }
    const attempts = Number(text(values.attempts) ?? "3");
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
      io.err("--attempts is a whole number from 1 to 10.");
      return 2;
    }
    try {
      const { runtime } = await runtimeForCli(root, {
        ...(text(values.mode) ? { mode: text(values.mode)! } : {}),
      });
      return await m.scanVerify(
        root,
        arg,
        {
          attempts,
          json: values.json === true,
          ...(text(values.resume) ? { resume: text(values.resume)! } : {}),
        },
        { runtime },
        io,
      );
    } catch (e) {
      if (e instanceof RuntimeConfigError) {
        io.err(e.message);
        return 2;
      }
      throw e;
    }
  }
  if (group === "scan" && command === "review") {
    const text = (v: unknown) => (typeof v === "string" ? v : undefined);
    if (!arg) {
      io.err(
        "Usage: atticus scan review <repo> [--gaps] [--name n] [--attempts 3] [--resume run] [--mode m]",
      );
      return 2;
    }
    const attempts = Number(text(values.attempts) ?? "3");
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
      io.err("--attempts is a whole number from 1 to 10.");
      return 2;
    }
    try {
      const { runtime } = await runtimeForCli(root, {
        ...(text(values.mode) ? { mode: text(values.mode)! } : {}),
      });
      return await scanReview(
        root,
        arg,
        {
          gapsOnly: values.gaps === true,
          attempts,
          ...(text(values.name) ? { name: text(values.name)! } : {}),
          ...(text(values.resume) ? { resume: text(values.resume)! } : {}),
        },
        { runtime },
        io,
      );
    } catch (e) {
      if (e instanceof RuntimeConfigError) {
        io.err(e.message);
        return 2;
      }
      throw e;
    }
  }
  if (group === "scan")
    return scanCommand(
      root,
      {
        ...(repoIds ? { repos: repoIds } : {}),
        full: values.full === true,
        dryRun: values["dry-run"] === true,
        json: values.json === true,
        noDrift: values["no-drift"] === true,
        warnings: values.warnings === true,
      },
      io,
    );
  if (group === "setup" && !command) return setupCommand(root, { json: values.json === true }, io);
  if (group === "doctor") return doctorCommand(root, { json: values.json === true }, io);
  if (group === "upgrade")
    return upgradeCommand(
      root,
      {
        check: values.check === true,
        dryRun: values["dry-run"] === true,
        ...(values.check === true || values["dry-run"] === true ? {} : { by: who() }),
        json: values.json === true,
      },
      io,
    );
  if (group === "support" && command === "bundle")
    return supportBundleCommand(
      root,
      {
        ...(typeof values.out === "string" && values.out ? { out: values.out } : {}),
        json: values.json === true,
      },
      io,
    );
  if (group === "baseline")
    return baselineCommand(
      root,
      {
        by: who(),
        ...(typeof values.note === "string" && values.note ? { note: values.note } : {}),
        ...(typeof values.site === "string" && values.site ? { site: values.site } : {}),
      },
      io,
    );
  if (group === "digest")
    return digestCommand(
      root,
      {
        as: typeof values.as === "string" && values.as ? values.as : who(),
        ...(typeof values.channel === "string" && values.channel
          ? { channel: values.channel }
          : {}),
        send: values.send === true,
        json: values.json === true,
      },
      io,
    );
  if (group === "guide") return guideCommand(root, command, { json: values.json === true }, io);
  if (group === "site" && command === "build")
    return siteBuildCommand(
      root,
      positionals[2],
      { ...(typeof values.title === "string" && values.title ? { title: values.title } : {}) },
      io,
    );
  if (group === "ask") {
    if (!command) {
      io.err('ask needs a question, for example: atticus ask "who calls ledger-api?"');
      return 2;
    }
    return askCommand(root, command, { json: values.json === true }, io);
  }
  if (group === "query") {
    if (!command) {
      io.err('query needs a query, for example: atticus query "kind:interface via:gateway"');
      return 2;
    }
    return queryCommand(
      root,
      command,
      { json: values.json === true, ...(num(values.limit) ? { limit: num(values.limit)! } : {}) },
      io,
    );
  }
  if (group === "impact") {
    if (!command) {
      io.err("impact needs a record id, for example: atticus impact ledger-db.entry");
      return 2;
    }
    return impactCommand(
      root,
      command,
      { json: values.json === true, ...(num(values.depth) ? { depth: num(values.depth)! } : {}) },
      io,
    );
  }
  if (group === "index" && command === "rebuild") return indexRebuild(root, io);
  if (group === "alias") {
    const target = positionals[2];
    if (!command || !target) {
      io.err(
        'alias needs a name and an id, for example: atticus alias "Ledger Platform" ledger-api',
      );
      return 2;
    }
    return aliasCommand(
      root,
      command,
      target,
      {
        by: who(),
        ...(typeof values.reason === "string" ? { reason: values.reason } : {}),
      },
      io,
    );
  }
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const json = values.json === true;
  if (group === "initiative") {
    const by = command === "status" ? undefined : who();
    const systems = Array.isArray(values.system) ? (values.system as string[]) : [];
    if (command === "new")
      return initiativeNew(
        root,
        {
          ...(arg ? { title: positionals.slice(2).join(" ") } : {}),
          ...(str(values.journey) ? { journey: str(values.journey)! } : {}),
          ...(by ? { by } : {}),
          ...(str(values.id) ? { id: str(values.id)! } : {}),
          ...(str(values.release) ? { release: str(values.release)! } : {}),
          ...(str(values.epic) ? { epic: str(values.epic)! } : {}),
          json,
        },
        io,
      );
    if (command === "plan")
      return initiativePlan(
        root,
        arg,
        {
          ...(str(values.target) ? { target: str(values.target)! } : {}),
          ...(str(values.release) ? { release: str(values.release)! } : {}),
          ...(systems.length ? { systems } : {}),
          ...(by ? { by } : {}),
          dryRun: values["dry-run"] === true,
          json,
        },
        io,
      );
    if (command === "status") return initiativeStatus(root, arg, { json }, io);
    if (command === "request")
      return requestFromTeam(
        root,
        arg,
        positionals[3],
        { ...(by ? { by } : {}), ...(systems.length ? { systems } : {}), json },
        io,
      );
    if (command === "commit")
      return initiativeCommitment(root, arg, positionals[3], { ...(by ? { by } : {}) }, io);
  }
  if (group === "learn") {
    if (!command || command === "list") return learnList(root, { json }, io);
    if (command === "start") return learnStart(root, arg, { json }, io);
    if (command === "check")
      return learnCheck(
        root,
        {
          ...(str(values.answer) ? { answer: str(values.answer)! } : {}),
          ...(str(values.lesson) ? { lesson: str(values.lesson)! } : {}),
          ...(str(values.step) ? { step: str(values.step)! } : {}),
          json,
        },
        io,
      );
  }
  if (group === "sandbox" && command === "create")
    return sandboxCreate(arg ? resolve(arg) : undefined, { json }, io);
  if (group === "explain")
    return explainCommand(root, positionals.slice(1).join(" ") || undefined, { json }, io);
  if (group === "eval" && command === "run")
    return evalRun(
      root,
      {
        ...(Array.isArray(values.agent) ? { agent: values.agent as string[] } : {}),
        ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
        ...(num(values.runs) ? { runs: num(values.runs)! } : {}),
        json,
      },
      io,
    );
  if (group === "eval" && command === "report") return evalReport(root, { json }, io);
  if (
    group === "bench" &&
    (command === "fetch" || command === "run" || command === "survey" || command === "verify")
  ) {
    const b = {
      ...(str(values.bench) ? { bench: str(values.bench)! } : {}),
      ...(str(values.cache) ? { cache: str(values.cache)! } : {}),
      ...(str(values.repo) ? { repo: str(values.repo)! } : {}),
      ...(num(values.batch) ? { batch: num(values.batch)! } : {}),
      ...(str(values.estate) ? { estate: str(values.estate)! } : {}),
      json,
    };
    if (command === "survey")
      return benchSurvey({ ...b, ...(str(values.mode) ? { mode: str(values.mode)! } : {}) }, io);
    if (command === "verify")
      return benchVerify({ ...b, ...(str(values.mode) ? { mode: str(values.mode)! } : {}) }, io);
    return command === "fetch"
      ? benchFetch(b, io)
      : benchRun({ ...b, ...(values.specs === true ? { specs: true } : {}) }, io);
  }
  if (group === "mcp") {
    // stdout carries the protocol only: every command's output is captured for its tool's reply.
    const run: McpRun = async (argv) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(
        [...argv, "--root", root],
        { out: (l) => out.push(l), err: (l) => err.push(l) },
        { quiet: true },
      );
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    const { serveMcp } = await import("./mcp.js");
    await serveMcp(process.stdin, process.stdout, run, VERSION);
    return 0;
  }
  if (group === "ui") {
    if (values.embed !== undefined && values.embed !== "vscode") {
      io.err(`--embed takes vscode (the app in a VS Code panel), not ${values.embed}.`);
      return 2;
    }
    const parent = values.parent === undefined ? undefined : Number(values.parent);
    if (parent !== undefined && !(Number.isInteger(parent) && parent > 0)) {
      io.err(`--parent takes a process id, not ${String(values.parent)}.`);
      return 2;
    }
    return uiCommand(
      root,
      {
        // --port 0 asks for any free port.
        ...(values.port === "0"
          ? { port: 0 }
          : num(values.port)
            ? { port: num(values.port)! }
            : {}),
        open: values.open === true,
        ...(values.embed === "vscode" ? { embed: "vscode" as const } : {}),
        ...(parent !== undefined ? { parent } : {}),
        version: VERSION,
        ...(given ? { user: given } : {}),
      },
      io,
    );
  }
  if (group === "conformance") {
    if (!command) {
      io.err(
        "conformance needs a folder or file to check, for example: atticus conformance catalog --kind catalog",
      );
      return 2;
    }
    return conformanceCommand(
      command,
      {
        ...(str(values.kind) ? { kind: str(values.kind)! } : {}),
        ...(str(values.executor) ? { executor: str(values.executor)! } : {}),
        ...(str(values.fixture) ? { fixture: str(values.fixture)! } : {}),
        json,
      },
      io,
    );
  }
  if (group === "defences" && command === "scan")
    return defencesScan(
      root,
      arg ? resolve(arg) : undefined,
      { json, all: values.all === true },
      io,
    );
  if (group === "tests" && command === "generate")
    return testsGenerate(
      root,
      arg,
      positionals[3],
      {
        ...(str(values.framework) ? { framework: str(values.framework)! } : {}),
        force: values.force === true,
        check: values.check === true,
        ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
        ...(str(values.resume) ? { resume: str(values.resume)! } : {}),
        json,
      },
      io,
    );
  if (group === "trace")
    return traceCommand(
      root,
      command,
      { json, csv: values.csv === true, write: values["no-write"] !== true },
      io,
    );
  if (group === "release") {
    if (command === "plan") return releasePlanCommand(root, arg, { json }, io);
    if (command === "forecast") return releaseForecastCommand(root, arg, { json }, io);
    if (command === "evidence")
      return releaseEvidenceCommand(
        root,
        arg,
        { ...(str(values.out) ? { out: str(values.out)! } : {}), json },
        io,
      );
    if (command === "notes")
      return releaseNotesCommand(
        root,
        arg,
        { ...(str(values.audience) ? { audience: str(values.audience)! } : {}), json },
        io,
      );
    if (command === "security") return releaseSecurityCommand(root, arg, { json }, io);
  }
  if (group === "outcome" && (!command || command === "list"))
    return outcomeList(
      root,
      { ...(str(values.change) ? { change: str(values.change)! } : {}), json },
      io,
    );
  if (group === "outcome" && command === "record")
    return outcomeRecord(
      root,
      arg,
      positionals[3],
      {
        ...(str(values.value) ? { value: str(values.value)! } : {}),
        by: who(),
        ...(str(values.note) ? { note: str(values.note)! } : {}),
        json,
      },
      io,
    );
  if (group === "ci" && command === "drift")
    return ciDrift(
      resolve(arg ?? "."),
      {
        ...(str(values.catalog) ? { catalog: resolve(str(values.catalog)!) } : {}),
        json: str(values["json-out"]) ?? json,
        ...(str(values.junit) ? { junit: str(values.junit)! } : {}),
        ...(str(values.summary) ? { summary: str(values.summary)! } : {}),
        warnOnly: values["warn-only"] === true,
        ...(str(values.repo) ? { repo: str(values.repo)! } : {}),
      },
      io,
    );
  if (group === "ci" && command === "snippet")
    return ciSnippet(arg, io, { ...(str(values.write) ? { write: str(values.write)! } : {}) });
  if (group === "ci" && command === "archive-gate")
    return ciArchiveGate(
      root,
      arg,
      { ...(Array.isArray(values.drift) ? { drift: values.drift as string[] } : {}), json },
      io,
    );
  if (group === "glossary") {
    const by = ["define", "link", "alias"].includes(command ?? "") ? who() : undefined;
    if (command === "list") return glossaryList(root, { json }, io);
    if (command === "scan")
      return glossaryScan(
        root,
        { ...(str(values.mode) ? { mode: str(values.mode)! } : {}), json },
        io,
      );
    const ownerOne = Array.isArray(values.owner)
      ? (values.owner[0] as string | undefined)
      : str(values.owner);
    if (command === "define")
      return glossaryDefine(
        root,
        arg,
        positionals.slice(3).join(" ") || undefined,
        { ...(by ? { by } : {}), ...(ownerOne ? { owner: ownerOne } : {}) },
        io,
      );
    if (command === "link")
      return glossaryLink(root, arg, positionals[3], { ...(by ? { by } : {}) }, io);
    if (command === "alias")
      return glossaryAlias(root, arg, positionals.slice(3), { ...(by ? { by } : {}) }, io);
  }
  if (group === "init") {
    const owner = Array.isArray(values.owner)
      ? (values.owner[0] as string | undefined)
      : str(values.owner);
    const dir = resolve(command ?? ".");
    const code = await initCommand(
      dir,
      {
        ...(command ? { name: basename(dir) } : {}),
        ...(str(values.platform) ? { platform: str(values.platform)! } : {}),
        ...(str(values.from) ? { packFrom: resolve(str(values.from)!) } : {}),
        ...(owner ? { owner } : {}),
        json,
      },
      io,
    );
    // A new metarepo starts up to date: record the Atticus that made it (ADR 0051).
    if (code === 0)
      await upgradeCommand(
        dir,
        { by: owner ?? (await gitUser(dir)).handle },
        { out: () => undefined, err: (l) => io.err(l) },
      );
    return code;
  }
  if (group === "adopt")
    return adoptCommand(
      resolve(command ?? "."),
      {
        json,
        ...(str(values.platform) ? { platform: str(values.platform)! } : {}),
        ...(str(values.name) ? { name: str(values.name)! } : {}),
      },
      io,
    );
  if (group === "unadopt") return unadoptCommand(resolve(command ?? "."), io);
  if (group === "repos" && command === "discover")
    return reposDiscoverCommand(
      root,
      {
        ...(arg ? { from: resolve(arg) } : {}),
        ...(str(values.org) ? { org: str(values.org)! } : {}),
        ...(str(values.platform) ? { platform: str(values.platform)! } : {}),
        dryRun: values["dry-run"] === true,
        json,
      },
      io,
    );
  if (group === "absorb") {
    if (str(values.refresh)) return absorbRefreshCommand(root, str(values.refresh), { json }, io);
    if (command === "accept")
      return absorbAcceptCommand(
        root,
        arg ?? "",
        { replace: values.replace === true, dryRun: values["dry-run"] === true, json },
        io,
      );
    if (!command) {
      io.err(
        "absorb needs a git URL or a folder, for example: atticus absorb ../payments-metarepo --id payments",
      );
      return 2;
    }
    return absorbCommand(
      root,
      command,
      {
        ...(str(values.id) ? { id: str(values.id)! } : {}),
        ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
        ...(str(values.ref) ? { ref: str(values.ref)! } : {}),
        json,
        dryRun: values["dry-run"] === true,
      },
      io,
    );
  }
  // An approval to write to an outside system is always explicit (--approve); the approver is
  // the person (ADR 0073).
  const approver = values.approve === true ? who() : undefined;
  const dryRun = values["dry-run"] === true;
  if (group === "plan") {
    if (!arg) {
      io.err(
        `plan ${command ?? ""} needs a change id, for example: atticus plan stories add-transfer-limit`.replace(
          "  ",
          " ",
        ),
      );
      return 2;
    }
    if (command === "stories")
      return planStories(
        root,
        arg,
        {
          force: values.force === true,
          draft: values.draft === true,
          ...(str(values.resume) ? { resume: str(values.resume)! } : {}),
          ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
          json,
        },
        io,
      );
    if (command === "snow") return snowDraft(root, arg, { force: values.force === true, json }, io);
    if (command === "bar")
      return storyBarCommand(
        root,
        arg,
        { ...(str(values.eval) ? { eval: str(values.eval)! } : {}), json },
        io,
      );
    if (command === "submit")
      return snowSubmit(
        root,
        arg,
        { ...(approver ? { approve: approver } : {}), dryRun, json },
        io,
      );
  }
  if (group === "ado" && command === "sync") {
    if (!arg) {
      io.err("ado sync needs a change id");
      return 2;
    }
    return adoSync(
      root,
      arg,
      {
        ...(approver ? { approve: approver } : {}),
        dryRun,
        ...(str(values.epic) ? { epic: str(values.epic)! } : {}),
        json,
      },
      io,
    );
  }
  if (group === "templates" && command === "draft")
    return templatesDraft(
      root,
      {
        ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
        json,
        noAi: values["no-ai"] === true,
      },
      io,
    );
  if (group === "executors" && command === "check") return executorsCheck(root, { json }, io);
  if (group === "todo") {
    if (!command || command === "list")
      return todoList(
        root,
        {
          json,
          ...(str(values.change) ? { change: str(values.change)! } : {}),
          all: values.all === true,
        },
        io,
      );
    if (!arg) {
      io.err(`todo ${command} needs a step id; see atticus todo`);
      return 2;
    }
    if (command === "show")
      return todoShow(
        root,
        arg,
        { ...(str(values.export) ? { export: str(values.export)! } : {}) },
        io,
      );
    if (command === "done") {
      const results = Array.isArray(values.result) ? (values.result as string[]) : [];
      return todoDone(
        root,
        arg,
        {
          result: results,
          by: who(),
          skip: values.skip === true,
          ...(str(values.note) ? { note: str(values.note)! } : {}),
        },
        io,
      );
    }
    if (command === "run")
      return todoRun(
        root,
        arg,
        {
          ...(str(values.with) ? { with: str(values.with)! } : {}),
          ...(approver ? { approve: approver } : {}),
          ...(str(values.inputs) ? { inputs: str(values.inputs)! } : {}),
          fillOnly: values["fill-only"] === true,
        },
        io,
      );
  }
  if (group === "task" && command === "run")
    return taskRun(
      root,
      arg,
      positionals[3],
      {
        ...(str(values.level) ? { level: str(values.level)! } : {}),
        ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
        by: who(),
        approve: values.approve === true,
        json,
      },
      io,
    );
  if (group === "spec" && command === "hand-down")
    return specHandDown(root, arg, positionals[3], { force: values.force === true, json }, io);
  if (group === "spec" && command === "hand-up")
    return specHandUp(
      root,
      arg,
      positionals[3],
      {
        by: who(),
        ...(num(values.pr) ? { pr: num(values.pr)! } : {}),
        ...(str(values["pr-url"]) ? { prUrl: str(values["pr-url"])! } : {}),
        json,
      },
      io,
    );
  if (group === "drift") return driftCommand(root, command, { json }, io);
  if (group === "assistant-files" && existsSync(join(root, ".atticus", "adopted.yaml")))
    return zeroInstallCommand(
      root,
      { check: values.check === true, force: values.force === true },
      io,
    );
  if (group === "assistant-files")
    return assistantFiles(
      root,
      {
        ...(str(values.repo) ? { repo: str(values.repo)! } : {}),
        ...(str(values.change) ? { change: str(values.change)! } : {}),
        force: values.force === true,
        check: values.check === true,
        json,
      },
      io,
    );
  if (group === "catalog" && command === "migrate")
    return catalogMigrate(root, io, { dryRun: values["dry-run"] === true });
  if (group === "feature") {
    const rest = positionals.slice(3);
    const writes = ["name", "tag", "merge", "split", "link"].includes(command ?? "");
    const by = writes ? who() : undefined;
    const firstOwner = Array.isArray(values.owner)
      ? (values.owner[0] as string | undefined)
      : str(values.owner);
    if (command === "list") return featureList(root, { json }, io);
    if (command === "suggest-links") return featureSuggestLinks(root, { json }, io);
    if (command === "suggest-names") {
      try {
        const { runtime } = await runtimeForCli(root, {
          ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
        });
        return await featureSuggestNames(root, { runtime, json }, io);
      } catch (e) {
        if (e instanceof RuntimeConfigError) {
          io.err(e.message);
          return 2;
        }
        throw e;
      }
    }
    if (!arg) {
      io.err(
        `feature ${command ?? ""} needs a feature id, for example: atticus feature show feature.transfers`,
      );
      return 2;
    }
    if (command === "show") return featureShow(root, arg, { json }, io);
    if (command === "spec") return featureSpec(root, arg, io);
    if (command === "name") {
      if (!rest[0]) {
        io.err(
          'feature name needs a name, for example: atticus feature name feature.transfers "Transfer money"',
        );
        return 2;
      }
      return featureName(
        root,
        arg,
        rest.join(" "),
        {
          ...(by ? { by } : {}),
          ...(str(values.description) ? { description: str(values.description)! } : {}),
          ...(firstOwner ? { owner: firstOwner } : {}),
        },
        io,
      );
    }
    if (command === "tag") return featureTag(root, arg, rest, { ...(by ? { by } : {}) }, io);
    if (command === "merge") return featureMerge(root, arg, rest, { ...(by ? { by } : {}) }, io);
    if (command === "split")
      return featureSplit(
        root,
        arg,
        rest,
        {
          ...(by ? { by } : {}),
          ...(str(values.name) ? { name: str(values.name)! } : {}),
          ...(str(values.into) ? { into: str(values.into)! } : {}),
        },
        io,
      );
    if (command === "link") {
      if (!rest[0]) {
        io.err(
          "feature link needs a reference, for example: atticus feature link feature.transfers ado:1234",
        );
        return 2;
      }
      return featureLink(
        root,
        arg,
        rest[0],
        { ...(by ? { by } : {}), ...(str(values.title) ? { title: str(values.title)! } : {}) },
        io,
      );
    }
  }
  if (group === "critic" && command === "stats") return criticStats(root, { json }, io);
  if (group === "critic") {
    if (!command) {
      io.err(
        "critic needs a change id, for example: atticus critic add-transfer-limit --gate design",
      );
      return 2;
    }
    return critic(
      root,
      command,
      {
        ...(str(values.gate) ? { gate: str(values.gate)! } : {}),
        ...(str(values.lens) ? { lens: str(values.lens)! } : {}),
        ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
        ...(values.resume ? { resume: true } : {}),
        json,
      },
      io,
    );
  }
  if (group === "findings") {
    if (!command) {
      io.err("findings needs a change id");
      return 2;
    }
    return findings(root, command, { json }, io);
  }
  if (group === "finding") {
    const [findingId, action] = positionals.slice(2);
    if (!command || !findingId || !action) {
      io.err(
        'finding needs a change, a finding id and an action, for example: atticus finding add-transfer-limit f-1 not-relevant --reason "..."',
      );
      return 2;
    }
    return findingAction(
      root,
      command,
      findingId,
      action,
      {
        by: who(),
        ...(str(values.reason) ? { reason: str(values.reason)! } : {}),
        ...(str(values["asked-of"]) ? { askedOf: str(values["asked-of"])! } : {}),
        ...(str(values.edit) ? { edit: str(values.edit)! } : {}),
        ...(str(values.gate) ? { gate: str(values.gate)! } : {}),
      },
      io,
    );
  }
  if (group === "change") {
    const list = (v: unknown) =>
      Array.isArray(v) ? (v as string[]) : typeof v === "string" ? [v] : undefined;
    const repo = str(values.repo);
    if (command === "new")
      return changeNew(
        root,
        {
          ...(arg ? { title: arg } : {}),
          ...(str(values.type) ? { type: str(values.type)! } : {}),
          ...(str(values.template) ? { template: str(values.template)! } : {}),
          ...(str(values.id) ? { id: str(values.id)! } : {}),
          by: who(),
          ...(list(values.owner) ? { owners: list(values.owner)! } : {}),
          ...(list(values.system) ? { systems: list(values.system)! } : {}),
        },
        io,
      );
    if (command === "list") return changeList(root, { json }, io);
    if (command === "conflicts") return changeConflicts(root, { json }, io);
    if (command === "draft")
      return changeDraft(
        root,
        arg,
        {
          ...(str(values.attempts) ? { attempts: Number(str(values.attempts)) } : {}),
          force: values.force === true,
          ...(str(values.resume) ? { resume: str(values.resume)! } : {}),
          ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
          json,
        },
        io,
      );
    if (!arg) {
      io.err(
        `change ${command ?? ""} needs a change id, for example: atticus change status add-transfer-limit`,
      );
      return 2;
    }
    if (command === "status") return changeStatus(root, arg, { json }, io);
    const approve = values.approve === true;
    if (command === "handoff")
      return changeHandoff(
        root,
        arg,
        {
          by: who(),
          approve,
          ...(repo ? { repo } : {}),
          ...(str(values.base) ? { base: str(values.base)! } : {}),
        },
        io,
      );
    if (command === "sync")
      return changeSync(
        root,
        arg,
        { ...(approve ? { by: who() } : {}), approve, ...(repo ? { repo } : {}) },
        io,
      );
    if (command === "return")
      return changeReturn(
        root,
        arg,
        {
          by: who(),
          approve,
          ...(str(values.reason) ? { reason: str(values.reason)! } : {}),
          ...(repo ? { repo } : {}),
        },
        io,
      );
    if (command === "archive" && (await ciArchiveGate(root, arg, { json: false }, io)) !== 0)
      return 1;
    if (command === "archive")
      return changeArchive(
        root,
        arg,
        { by: who(), ...(values["no-rescan"] === true ? { rescan: false } : {}) },
        io,
      );
  }
  if (group === "intake" && command === "add")
    return intakeAdd(
      root,
      positionals.slice(2).map((f) => resolve(f)),
      io,
    );
  if (group === "intake" && command === "list") return intakeList(root, io, { json });
  if (group === "triage" && !command) return triageList(root, io, { json });
  if (group === "triage" && command === "decide") {
    const [item, option] = positionals.slice(2);
    if (!item || !option || !num(option)) {
      io.err(
        "triage decide needs an item id and an option number, for example: atticus triage decide alias-needed.ledger-platform 1",
      );
      return 2;
    }
    return triageDecide(
      root,
      item,
      num(option)!,
      {
        by: who(),
        ...(str(values.reason) ? { reason: str(values.reason)! } : {}),
      },
      io,
    );
  }
  if (group === "diagram" && command === "render") {
    if (!arg) {
      io.err("diagram render needs a view or a file, for example: atticus diagram render context");
      return 2;
    }
    return diagramRender(
      root,
      {
        view: arg,
        ...(str(values.focus) ? { focus: str(values.focus)! } : {}),
        ...(str(values.format) ? { format: str(values.format)! } : {}),
        ...(str(values.out) ? { out: str(values.out)! } : {}),
      },
      io,
    );
  }
  if (group === "diagram" && command === "library") {
    if (!arg) {
      io.err(
        "diagram library needs a file to write, for example: atticus diagram library atticus.xml",
      );
      return 2;
    }
    return diagramLibrary(arg, io);
  }
  if (group === "stub" && command === "serve") {
    if (!arg) {
      io.err(
        "stub serve needs a spec file or a catalog id, for example: atticus stub serve api/openapi.yaml",
      );
      return 2;
    }
    return stubServe(
      root,
      arg,
      {
        ...(num(values.port) ? { port: num(values.port)! } : {}),
        ...(str(values.host) ? { host: str(values.host)! } : {}),
        catalog: values["from-catalog"] === true,
      },
      io,
    );
  }
  if (group === "stub" && command === "check") {
    if (!arg) {
      io.err("stub check needs a spec file");
      return 2;
    }
    return stubCheck(arg, io);
  }
  if (group === "onboard") {
    // Framework models (ADR 0066): onboard framework, onboard check framework, onboard accept framework.
    const list = (v: unknown) =>
      (str(v) ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    const fwOptions = () => ({
      ...(str(values.from) ? { from: str(values.from)! } : {}),
      ...(list(values.users).length ? { users: list(values.users) } : {}),
      ...(list(values.package).length ? { packages: list(values.package) } : {}),
    });
    if ((command === "check" || command === "accept") && arg === "framework") {
      const name = positionals[3];
      if (!name) {
        io.err(
          `onboard ${command} framework needs the model's name: atticus onboard ${command} framework <name>`,
        );
        return 2;
      }
      return command === "check"
        ? onboardFrameworkCheck(root, name, fwOptions(), io)
        : onboardFrameworkAccept(root, name, { replace: values.replace === true }, io);
    }
    if (command === "framework") {
      if (!arg) {
        io.err(
          "onboard framework needs a name and the framework's source: atticus onboard framework <name> --from <source|jar|tgz> [--users <repo>,...]",
        );
        return 2;
      }
      const attempts = Number(str(values.attempts) ?? "3");
      if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
        io.err("--attempts is a whole number from 1 to 10.");
        return 2;
      }
      let runtime: AiRuntime | undefined;
      if (values["no-ai"] !== true)
        try {
          runtime = (
            await runtimeForCli(root, { ...(str(values.mode) ? { mode: str(values.mode)! } : {}) })
          ).runtime;
        } catch (e) {
          if (e instanceof AiOffError)
            io.out("AI is off here: the learned model alone is checked.");
          else if (e instanceof RuntimeConfigError) {
            io.err(e.message);
            return 2;
          } else throw e;
        }
      return onboardFramework(
        root,
        arg,
        { ...fwOptions(), attempts },
        { ...(runtime ? { runtime } : {}) },
        io,
      );
    }
    if (command === "check") {
      const repo = str(values.repo);
      if (!arg || !repo) {
        io.err(
          "onboard check needs a proposal and its repo: atticus onboard check <name> --repo <repo>",
        );
        return 2;
      }
      return onboardCheck(root, arg, repo, io);
    }
    if (command === "accept") {
      if (!arg) {
        io.err("onboard accept needs the proposal's name: atticus onboard accept <name>");
        return 2;
      }
      return onboardAccept(root, arg, { replace: values.replace === true }, io);
    }
    if (command === "eval") {
      if (!arg) {
        io.err(
          "onboard eval needs a folder of cases: atticus onboard eval fixtures/onboard-eval --mode model",
        );
        return 2;
      }
      try {
        const { runtime } = await runtimeForCli(root, {
          ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
        });
        return await onboardEval(root, arg, { json }, { runtime }, io);
      } catch (e) {
        if (e instanceof RuntimeConfigError) {
          io.err(e.message);
          return 2;
        }
        throw e;
      }
    }
    if (!command) {
      io.err(
        "onboard needs a repo: atticus onboard <repo-id|folder> [--name <dialect>] [--attempts 3] [--mode model]",
      );
      return 2;
    }
    const attempts = Number(str(values.attempts) ?? "3");
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
      io.err("--attempts is a whole number from 1 to 10.");
      return 2;
    }
    try {
      const { runtime } = await runtimeForCli(root, {
        ...(str(values.mode) ? { mode: str(values.mode)! } : {}),
      });
      return await onboardDraft(
        root,
        command,
        { ...(str(values.name) ? { name: str(values.name)! } : {}), attempts },
        { runtime },
        io,
      );
    } catch (e) {
      if (e instanceof RuntimeConfigError) {
        io.err(e.message);
        return 2;
      }
      throw e;
    }
  }
  if (group === "frameworks" && command === "check") return frameworksCheck(root, arg, io);
  if (group === "frameworks" && command === "kit")
    return frameworksKit(resolve(arg ?? "frameworks-kit"), io);
  if (group === "frameworks" && command === "survey") {
    const pkg = str(values.package);
    return frameworksSurvey(
      root,
      {
        prefixes: pkg
          ? pkg
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean)
          : [],
        json: values.json === true,
      },
      io,
    );
  }
  if (group === "frameworks" && command === "discover") {
    const strings = (v: unknown) =>
      (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string");
    const groups = strings(values.group)
      .flatMap((g) => g.split(","))
      .map((g) => g.trim())
      .filter(Boolean);
    return frameworksDiscover(
      root,
      {
        groups,
        jars: strings(values.jars),
        learn: values.learn === true,
        json: values.json === true,
      },
      io,
    );
  }
  if (group === "frameworks") {
    const from = str(values.from);
    if (command !== "learn" || !arg || !from) {
      io.err(
        "frameworks learn needs a name and the starter's source, for example: atticus frameworks learn tide-platform --from workspace/tide-platform",
      );
      return 2;
    }
    const pkg = str(values.package);
    return frameworksLearn(
      root,
      arg,
      from,
      {
        ...(pkg ? { packages: pkg.split(",").map((x) => x.trim()) } : {}),
        dryRun: values["dry-run"] === true,
      },
      io,
    );
  }
  if (group === "plugin" && (command === "test" || command === "pin")) {
    if (!arg) {
      io.err(
        `plugin ${command} needs a plugin id, for example: atticus plugin ${command} forge-routes`,
      );
      return 2;
    }
    return command === "test" ? pluginTest(root, arg, io) : pluginPin(root, arg, io);
  }
  if (group === "dialect") {
    const rest = positionals.slice(3);
    if (command === "kit") return dialectKit(resolve(arg ?? "dialect-kit"), io);
    if (command === "tree") {
      if (!arg) {
        io.err("dialect tree needs a file: atticus dialect tree src/A.java [--language java]");
        return 2;
      }
      return dialectTree(
        arg,
        { ...(str(values.language) ? { language: str(values.language)! } : {}) },
        io,
      );
    }
    if (!arg) {
      io.err(
        `dialect ${command ?? ""} needs a dialect name, for example: atticus dialect test forge`.replace(
          "  ",
          " ",
        ),
      );
      return 2;
    }
    if (command === "new") {
      const repos = [...(str(values.from)?.split(",") ?? []), ...rest]
        .map((r) => r.trim())
        .filter(Boolean);
      if (repos.length === 0) {
        io.err(
          "dialect new needs sample repos, for example: atticus dialect new forge --from workspace/forge-ledger",
        );
        return 2;
      }
      return dialectNew(root, arg, repos, io);
    }
    if (command === "test") return dialectTest(root, arg, io);
    if (command === "run") {
      if (!rest[0]) {
        io.err(
          "dialect run needs a repo folder, for example: atticus dialect run forge workspace/forge-ledger",
        );
        return 2;
      }
      return dialectRun(root, arg, rest[0], { json }, io);
    }
    if (command === "grade") {
      if (!rest[0]) {
        io.err("dialect grade needs a dialect file and an eval folder");
        return 2;
      }
      return dialectGrade(arg, rest[0], io);
    }
  }
  if (
    (group === "sources" && command === "tag") ||
    group === "knowledge" ||
    (group === "bench" && command === "knowledge")
  ) {
    const handled = await knowledgeCli(root, positionals, values, io, who);
    if (handled !== undefined) return handled;
  }
  if (group === "sources" && command === "add") {
    const [kind, location] = positionals.slice(2);
    if (!kind || !location) {
      io.err(
        "sources add needs a type and a location, for example: atticus sources add markdown-folder ../wiki",
      );
      return 2;
    }
    const listOf = (v: unknown) =>
      typeof v === "string"
        ? v
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : undefined;
    return sourcesAdd(root, kind, location, io, {
      ...(str(values.id) ? { id: str(values.id)! } : {}),
      ...(str(values.path) ? { path: str(values.path)! } : {}),
      ...(str(values.ref) ? { ref: str(values.ref)! } : {}),
      ...(values.submodule === true ? { submodule: true } : {}),
      ...(listOf(values.kind) ? { kinds: listOf(values.kind)! } : {}),
      ...(listOf(values.framework) ? { frameworks: listOf(values.framework)! } : {}),
      ...(Array.isArray(values.owner) && values.owner[0] ? { owner: String(values.owner[0]) } : {}),
      ...(values.save === true ? { save: true } : {}),
    });
  }
  if (group === "sources" && command === "refresh")
    return sourcesRefreshCommand(root, { json }, io);
  if (group === "sources" && command === "sync")
    return sourcesSync(root, io, {
      json: values.json === true,
      ...(str(values.source) ? { source: str(values.source)! } : {}),
    });
  if (group === "patterns" && command === "scan")
    return patternsScan(root, io, { json: values.json === true });
  if (group === "coverage") return coverageCommand(root, io, { json: values.json === true });
  if (group === "domain" && command === "profile")
    return domainProfileCommand(root, arg, str(values.out) ? { out: str(values.out)! } : {}, io);
  if (group === "questions" && (command === "list" || command === "answer"))
    return questionsFiles(root, argv, io);
  if (group === "questions") return questionsCommand(root, io, { json: values.json === true });
  if (group === "reconcile")
    return reconcileCommand(root, positionals.slice(1), { json: values.json === true }, io);
  // ADR 0101: the profile's systems drafted from the knowledge, and a person's accept.
  if (group === "orgpack" && (command === "draft" || command === "accept"))
    return (await import("./orgpack-draft-commands.js")).orgPackDraftCli(
      root,
      command,
      arg,
      values,
      io,
    );
  if (group === "orgpack" && command === "validate")
    return orgPackValidate(arg ? resolve(arg) : join(orgPackDirOf(root)), io);
  if (group === "handoff" && command === "done") {
    if (!arg) {
      io.err(
        "handoff done needs the run id from the prompt, for example: atticus handoff done run-20261018060000-0001",
      );
      return 2;
    }
    if (await (await import("@maycombhq/taskrun")).isTaskRun(root, arg))
      return taskHandoff(
        root,
        arg,
        {
          by: who(),
          approve: values.approve === true,
          json,
        },
        io,
      );
    return handoffDone(root, arg, io);
  }
  if (group === "openspec" && command === "setup") return openspecSetup(root, io);
  if (group === "openspec" && command === "check") return openspecCheck(root, io);
  if (group === "workspace" && command === "sync") return workspaceSync(root, repoIds, io);
  if (group === "workspace" && (command === "open" || command === "prune")) {
    if (!arg) {
      io.err(
        `workspace ${command} needs a change id, for example: atticus workspace ${command} add-transfer-limit`,
      );
      return 2;
    }
    if (command === "open") return workspaceOpen(root, arg, repoIds, io);
    return workspacePrune(
      root,
      arg,
      { all: values.all === true, force: values.force === true },
      io,
    );
  }
  io.err(`Unknown command: ${positionals.join(" ")}\n\n${HELP}`);
  return 2;
}
