/**
 * The parts of the app's local API (contract C4, docs/api/openapi.json) the sidebar reads (ADR
 * 0093). Written out here because the extension ships with no dependencies; only the fields it
 * uses, so an addition to the API never breaks it.
 */
export interface Evidence {
  source: string;
  repo?: string;
  path?: string;
  line?: number;
  record?: string;
}

export interface OnboardingRepo {
  id: string;
  type: string;
  owner: string;
  manifest: string;
  cloned: boolean;
  scanSettings: { path: string; present: boolean };
  lastScan: { records: number; kinds: Record<string, number>; commit?: string } | null;
}
export interface Sources {
  path: string;
  present: boolean;
  wikis: { id: string; type: string; location: string; spaces: string[]; owner?: string }[];
  absorbed: { id: string; url: string; format: string; mode: string }[];
}
export interface OnboardingView {
  repos: OnboardingRepo[];
  sources?: Sources;
}

export interface SpecList {
  repos: { repo: string; flows: number }[];
}
export interface SpecFlowSummary {
  id: string;
  name: string;
  component: string;
  trigger: { kind: string; what: string };
  steps: number;
  confirmed: number;
  errors: number;
  calls: number;
  calledBy: number;
}
export interface SpecView {
  repo: string;
  path: string;
  flows: SpecFlowSummary[];
  problems: { file: string; message: string }[];
}

export interface FlowData {
  sends?: string[];
  returns?: string[];
  reads?: string[];
  checks?: string[];
  from?: string[];
  to?: string[];
}
export interface FlowStep {
  kind: string;
  what: string;
  to?: { component: string; entry: string };
  data?: FlowData;
  store?: { table: string; columns: string[] };
  evidence: Evidence[];
  confirmedBy?: string;
}
export interface Flow {
  id: string;
  component: string;
  name: string;
  trigger: { kind: string; what: string; evidence: Evidence[] };
  steps: FlowStep[];
  errors: { when: string; then: string; evidence: Evidence[] }[];
}
export interface FlowView {
  repo: string;
  file: string;
  flow: Flow;
  joined: boolean;
  calls: { step: number; repo: string; flow: string; name?: string }[];
  calledBy: { step: number; repo: string; flow: string; name?: string }[];
  unmatched: { step: number; entry: string; reason: string; message: string }[];
}

export interface ChangeSummary {
  id: string;
  title: string;
  type: string;
  state: string;
  repos: string[];
  openFindings: { blocking: number; gap: number; risk: number; idea: number };
  updatedAt: string;
}
export interface ChangeDetail extends ChangeSummary {
  artifacts: { artifact: string; path: string; status: string; openFindings: number }[];
}
export interface Finding {
  id: string;
  kind: string;
  change: string;
  /** constitution, checklist… A constitution rule's finding is never waived. */
  layer?: string;
  severity: string;
  waivable?: boolean;
  artifact: string;
  summary: string;
  why: string;
  fix: { text: string; patch?: string };
  /** For a knowledge gap: the owner question and who should answer. */
  question?: { text: string; owner: string };
  state?: string;
}

export interface KindCount {
  kind: string;
  count: number;
  stale: number;
}
export interface CatalogRecord {
  kind: string;
  id: string;
  name?: string;
  status: string;
  confidence: string;
  evidence: Evidence[];
}
export interface RecordPage {
  items: CatalogRecord[];
  total: number;
  next?: string;
}

export interface CiteList {
  repo: string;
  path: string;
  lines: {
    line: number;
    flows: {
      repo: string;
      flow: string;
      name: string;
      step: number;
      kind: string;
      confirmedBy?: string;
    }[];
    records: { kind: string; id: string; name?: string; source: string }[];
  }[];
}

export interface TargetFlowList {
  change: string;
  flows: {
    flow: string;
    repo: string;
    change: string;
    name: string;
    why: string;
    added: number;
    changed: number;
    removed: number;
  }[];
  problems: string[];
}

export interface Task {
  id: string;
  repo: string;
  description: string;
  done: boolean;
  story?: string;
  branch?: string;
}

export interface KnowledgeItem {
  kind: string;
  id: string;
  name?: string;
  title?: string;
  status: string;
  confidence: string;
  evidence: Evidence[];
}

export interface Doctor {
  checks: { id: string; label: string; status: string; detail: string; fix: string }[];
}
