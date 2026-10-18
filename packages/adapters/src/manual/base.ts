import type { ManualStep, ManualSystem, Procedure } from "@maycombhq/core";
import { AdapterError, requireApproval, type Approval } from "../common.js";
import { stepApproval, type NewStep, type StepStore } from "./steps.js";

/**
 * Shared parts of the manual adapters (ADR 0032). A manual adapter implements the same C4
 * interface as a live one, so the lifecycle and planning code can't tell them apart: writes
 * become steps a person does in the real system, reads come from exports, and states the
 * system can't report are asked of a person (an "ask" step). Approval rules are unchanged:
 * the write a step stands for still needs a person's approval before the step is created.
 */

type Settings = Record<string, string | number | boolean | string[]>;

export interface ManualOptions {
  store: StepStore;
  /** The change the steps belong to, when the call itself doesn't say. */
  change?: string;
  /** runtime.yaml settings of the adapter (patterns for ids, the default branch, export folders). */
  settings?: Settings;
  /** Org-pack procedures, so steps can name the procedure they follow (ADR 0033). */
  procedures?: Procedure[];
  /** The metarepo root, for adapters that read exports from files. */
  root?: string;
  now?: () => string;
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** An approval after `requireApproval` checked it. */
export type Approved = ReturnType<typeof requireApproval>;

export const PROVISIONAL = "manual:";

/** The provisional id a manual write returns until the person records the real one. */
export const provisionalId = (stepId: string) => `${PROVISIONAL}${stepId}`;
export const stepOfProvisional = (id: string) =>
  id.startsWith(PROVISIONAL) ? id.slice(PROVISIONAL.length) : undefined;

export abstract class ManualBase {
  /** Set by the fallback wrapper while it hands one call to this adapter. */
  reason?: string;
  readonly journal: { method: string; step?: string }[] = [];

  constructor(
    protected readonly name: string,
    protected readonly system: ManualSystem,
    protected readonly opts: ManualOptions,
  ) {}

  protected now(): string {
    return this.opts.now?.() ?? nowIso();
  }

  protected setting(key: string): string | undefined {
    const v = this.opts.settings?.[key];
    return typeof v === "string" ? v : undefined;
  }

  protected settingList(key: string): string[] | undefined {
    const v = this.opts.settings?.[key];
    return Array.isArray(v) ? v : typeof v === "string" ? [v] : undefined;
  }

  protected approve(approval: Approval, o: { allowStanding?: boolean } = {}) {
    return requireApproval(this.name, approval, o);
  }

  /** The procedure (and step) for a kind of write, if the org pack has one. */
  protected procedureFor(
    kind: string,
    o: { template?: string } = {},
  ): { procedure: string; procedureStep: string } | undefined {
    for (const p of this.opts.procedures ?? []) {
      if (p.status === "retired") continue;
      if (o.template && p.template !== o.template) continue;
      if (!o.template && p.system !== this.system) continue;
      const s = p.steps.find((x) => x.kind === kind);
      if (s) return { procedure: p.id, procedureStep: s.id };
    }
    return undefined;
  }

  protected async step(
    method: string,
    s: Omit<NewStep, "system" | "createdBy" | "createdAt"> & { createdBy?: string },
    approval?: Approved,
  ): Promise<ManualStep> {
    const created = await this.opts.store.create({
      ...s,
      system: this.system,
      createdBy: (s.createdBy ?? approval?.by ?? "atticus").replace(/^@/, ""),
      createdAt: this.now(),
      ...(approval ? { approval: stepApproval(approval) } : {}),
      ...((s.change ?? this.opts.change) ? { change: s.change ?? this.opts.change } : {}),
      ...(this.reason ? { reason: this.reason } : {}),
    });
    this.journal.push({ method, step: created.id });
    return created;
  }

  protected notFound(what: string, hint: string): never {
    throw new AdapterError(this.name, "not-found", `${what} not found: ${hint}`);
  }
}
