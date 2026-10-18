import type { CatalogRecord, EvidenceT, RecordOf } from "@maycombhq/core";
import { classOf, nameWords, singular, splitWords, tokens } from "./words.js";

export type Iface = RecordOf<"Interface">;
export type EndpointRec = RecordOf<"Endpoint">;
export type ComponentRec = RecordOf<"Component">;
export type TableRec = RecordOf<"Table">;
export type SettingRec = RecordOf<"Setting">;
export type SystemRec = RecordOf<"System">;
export type CapabilityRec = RecordOf<"Capability">;
export type UnresolvedRec = RecordOf<"Unresolved">;

const UI = /\b(spa|ui|web|webapp|frontend|front-end|mobile|angular|react|vue|next|nuxt|svelte)\b/i;
const JOB = /batch|job|cron|schedul/i;

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
};

export interface TableUse {
  table: TableRec;
  read: boolean;
  write: boolean;
}

/**
 * The parts of the catalog a flow walks, indexed once: who calls an endpoint, what a
 * component calls or publishes, which tables it reads and writes, its schedules and its
 * loose ends. Retired records are left out: they are no longer part of any flow.
 */
export class FlowGraph {
  readonly records = new Map<string, CatalogRecord>();
  readonly components = new Map<string, ComponentRec>();
  readonly systems = new Map<string, SystemRec>();
  readonly endpoints = new Map<string, EndpointRec>();
  readonly interfaces = new Map<string, Iface>();
  /** Interfaces by caller (or publisher). */
  readonly out = new Map<string, Iface[]>();
  /** Interfaces by the endpoint they call (or the topic they carry). */
  readonly callers = new Map<string, Iface[]>();
  /** Interfaces by callee (or subscriber). */
  readonly into = new Map<string, Iface[]>();
  readonly tables = new Map<string, TableUse[]>();
  readonly schedules = new Map<string, SettingRec[]>();
  readonly settings = new Map<string, SettingRec>();
  readonly unresolved = new Map<string, UnresolvedRec[]>();
  readonly capabilities: CapabilityRec[] = [];
  /** Every record, for checks that look further (tests, alerts, documents). */
  readonly all: CatalogRecord[];

  constructor(input: readonly CatalogRecord[]) {
    const live = input.filter((r) => r.status !== "retired" && r.kind !== "CuratedDecision");
    this.all = live;
    for (const r of [...live].sort((a, b) => byId(a, b) || (a.kind < b.kind ? -1 : 1))) {
      if (!this.records.has(r.id) || r.kind === "Component") this.records.set(r.id, r);
      switch (r.kind) {
        case "Component":
          this.components.set(r.id, r);
          break;
        case "System":
          this.systems.set(r.id, r);
          break;
        case "Endpoint":
          this.endpoints.set(r.id, r);
          break;
        case "Interface":
          this.interfaces.set(r.id, r);
          push(this.out, r.from, r);
          push(this.into, r.to, r);
          if (r.endpoint) push(this.callers, r.endpoint, r);
          break;
        case "Table": {
          const uses = new Map<string, TableUse>();
          for (const c of r.readers) uses.set(c, { table: r, read: true, write: false });
          for (const c of r.writers) {
            const u = uses.get(c);
            if (u) u.write = true;
            else uses.set(c, { table: r, read: false, write: true });
          }
          for (const [c, u] of uses) push(this.tables, c, u);
          break;
        }
        case "Setting":
          this.settings.set(r.id, r);
          if (/^schedule\./.test(r.key)) push(this.schedules, r.component, r);
          break;
        case "Unresolved":
          if (r.owner) push(this.unresolved, r.owner, r);
          break;
        case "Capability":
          this.capabilities.push(r);
          break;
        default:
          break;
      }
    }
  }

  systemOf(id: string): string | undefined {
    return this.components.get(id)?.system ?? (this.systems.has(id) ? id : undefined);
  }

  isVendor(id: string): boolean {
    const s = this.systemOf(id);
    return s !== undefined && this.systems.get(s)?.boundary === "vendor";
  }

  /** A component of our own whose code a flow can continue into. */
  isOwn(id: string): boolean {
    return this.components.has(id) && !this.isVendor(id);
  }

  isUi(id: string): boolean {
    const c = this.components.get(id);
    return !!c && UI.test(c.type);
  }

  isJob(id: string): boolean {
    const c = this.components.get(id);
    return !!c && JOB.test(c.type);
  }

  /** Words that name the component or its system: they say where code is, not what it does. */
  ownWords(component: string): Set<string> {
    const s = this.systemOf(component);
    const sys = s ? this.systems.get(s) : undefined;
    return tokens([
      ...splitWords(component),
      ...(s ? splitWords(s) : []),
      ...(sys ? splitWords(sys.name) : []),
    ]);
  }

  /** The system's name as one singular word for job names (Reports → report), if it has one. */
  systemWord(component: string): string | undefined {
    const s = this.systemOf(component);
    const words = splitWords((s && this.systems.get(s)?.name) ?? s ?? "");
    const last = words.at(-1);
    return last ? singular(last) : undefined;
  }

  /** Words of the classes the evidence points at (BalanceController → balance), minus `own`. */
  classTokens(evidence: readonly EvidenceT[], own: Set<string>, sides: string[]): Set<string> {
    const out = new Set<string>();
    for (const e of evidence) {
      if (!e.path || (e.side && !sides.includes(e.side))) continue;
      const cls = classOf(e.path);
      if (!cls) continue;
      for (const t of tokens(nameWords(cls))) if (!own.has(t)) out.add(t);
    }
    return out;
  }

  outOf(component: string): Iface[] {
    return [...(this.out.get(component) ?? [])].sort(byId);
  }
}
