import type { ManualStep } from "@maycombhq/core";
import { AdapterError, type Approval } from "../common.js";
import type { RequestDraft, RequestState, ServiceDesk, ServiceRequest } from "../service-desk.js";
import { ManualBase, provisionalId, stepOfProvisional, type ManualOptions } from "./base.js";
import { shortHash } from "./steps.js";

/** Reads past requests from exports (intake's service-request reader). */
export type RequestExportReader = () => Promise<ServiceRequest[]>;

const STATES: RequestState[] = ["draft", "submitted", "in-progress", "done", "rejected"];
const FINAL = new Set<RequestState>(["done", "rejected"]);

/** "Source app" → "sourceApp": the key a procedure's inputs use for a template field. */
export const fieldKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ""))
    .replace(/^[^a-z]+/, "");

/**
 * The service desk when Atticus can't reach it. Submitting a request becomes a step with the
 * request type and every field ready to copy; the person records the request number. The
 * desk's progress on a request is something Atticus can't see, so reading a request that
 * isn't finished asks a person for its state. Past requests come from exports.
 */
export class ManualServiceDesk extends ManualBase implements ServiceDesk {
  constructor(
    opts: ManualOptions,
    private readonly exports: RequestExportReader = async () => [],
  ) {
    super("service-desk", "service-desk", opts);
  }

  private numberPattern(): string {
    return this.setting("numberPattern") ?? "[A-Z]{2,10}-?\\d{3,}";
  }

  /** The request number once its step is recorded, else the id as given. */
  async resolveId(id: string): Promise<string> {
    const stepId = stepOfProvisional(id);
    if (!stepId) return id;
    const s = await this.opts.store.get(stepId);
    const real = s?.state === "done" ? s.recorded?.values.requestNumber : undefined;
    return typeof real === "string" ? real : id;
  }

  private async stateAnswers(number: string): Promise<ManualStep[]> {
    return (await this.opts.store.list({ system: "service-desk", action: "report-request-state" }))
      .filter((s) => s.inputs.request === number && s.state === "done")
      .sort((a, b) => (a.recorded!.at < b.recorded!.at ? -1 : 1));
  }

  private async fromStep(step: ManualStep): Promise<ServiceRequest> {
    const rec = step.state === "done" ? step.recorded?.values : undefined;
    const number = typeof rec?.requestNumber === "string" ? rec.requestNumber : undefined;
    const fields = Object.fromEntries(
      step.fields.filter((f) => f.name !== "Request type").map((f) => [f.name, f.value]),
    );
    let state: RequestState = number ? "submitted" : "draft";
    let closedAt: string | undefined;
    if (number) {
      const last = (await this.stateAnswers(number)).at(-1);
      const s = last?.recorded?.values.state;
      if (typeof s === "string" && (STATES as string[]).includes(s)) state = s as RequestState;
      const c = last?.recorded?.values.closedAt;
      if (typeof c === "string") closedAt = c;
    }
    return {
      id: number ?? provisionalId(step.id),
      type: String(step.inputs.requestType ?? ""),
      state,
      fields,
      ...(step.change ? { changeId: step.change } : {}),
      ...(step.recorded?.at && number ? { openedAt: step.recorded.at.slice(0, 10) } : {}),
      ...(closedAt ? { closedAt } : {}),
      url: typeof rec?.url === "string" ? rec.url : "",
    };
  }

  private async submitted(): Promise<ServiceRequest[]> {
    const steps = await this.opts.store.list({ system: "service-desk", action: "submit-request" });
    return Promise.all(steps.map((s) => this.fromStep(s)));
  }

  /** Ask a person where an unfinished request is; one open question per request at a time. */
  private async ask(r: ServiceRequest): Promise<void> {
    const answered = (await this.stateAnswers(r.id)).length;
    await this.step("getRequest", {
      slug: `state-${r.id}`,
      action: "report-request-state",
      key: `service-desk|state|${r.id}|${answered}`,
      title: `Report where request ${r.id} is in the service desk`,
      where: `Service desk: request ${r.id}`,
      ...(r.changeId ? { change: r.changeId } : {}),
      inputs: { request: r.id },
      fields: [
        { name: "Request", value: r.id },
        { name: "Request type", value: r.type },
      ],
      instructions: [
        "Open the request and record its state; give the closing date once it is done or rejected.",
      ],
      result: [
        { name: "state", label: "State", format: "choice", choices: STATES, required: true },
        { name: "closedAt", label: "Closed on", format: "date", required: false },
      ],
    });
  }

  async getRequest(id: string): Promise<ServiceRequest> {
    this.journal.push({ method: "getRequest" });
    const stepId = stepOfProvisional(id);
    const mine = stepId
      ? await this.opts.store.get(stepId).then((s) => (s ? this.fromStep(s) : undefined))
      : (await this.submitted()).find((r) => r.id === id);
    if (mine) {
      if (mine.state !== "draft" && !FINAL.has(mine.state)) await this.ask(mine);
      return mine;
    }
    const exported = (await this.exports()).find((r) => r.id === id);
    return (
      exported ??
      this.notFound(
        `request ${id}`,
        "export the requests from the service desk into inputs/ so Atticus can read them",
      )
    );
  }

  async listRequests(q: { changeId?: string; state?: RequestState; type?: string }) {
    this.journal.push({ method: "listRequests" });
    const mine = await this.submitted();
    const ids = new Set(mine.map((r) => r.id));
    return [...mine, ...(await this.exports()).filter((r) => !ids.has(r.id))].filter(
      (r) =>
        (!q.changeId || r.changeId === q.changeId) &&
        (!q.state || r.state === q.state) &&
        (!q.type || r.type === q.type),
    );
  }

  async submitRequest(draft: RequestDraft, approval: Approval): Promise<ServiceRequest> {
    const a = this.approve(approval);
    const empty = Object.entries(draft.fields)
      .filter(([, v]) => v === "")
      .map(([k]) => k);
    if (empty.length > 0)
      throw new AdapterError(
        this.name,
        "invalid",
        `required fields are empty: ${empty.join(", ")}`,
      );
    const proc = this.procedureFor("submit-request", { template: draft.templateId });
    const step = await this.step(
      "submitRequest",
      {
        slug: `request-${draft.templateId}`,
        action: "submit-request",
        key: `service-desk|${draft.changeId}|${draft.templateId}|${shortHash(JSON.stringify(draft.fields))}`,
        title: `Raise a "${draft.type}" request in the service desk`,
        where: `Service desk: "${draft.type}" request`,
        change: draft.changeId,
        ...(proc ?? {}),
        inputs: {
          template: draft.templateId,
          requestType: draft.type,
          ...Object.fromEntries(Object.entries(draft.fields).map(([k, v]) => [fieldKey(k), v])),
        },
        fields: [
          { name: "Request type", value: draft.type },
          ...Object.entries(draft.fields).map(([name, v]) => ({ name, value: String(v) })),
        ],
        instructions: [
          `Open a new "${draft.type}" request and copy the fields below.`,
          "Submit it and record the request number here.",
        ],
        result: [
          {
            name: "requestNumber",
            label: "Request number",
            format: "pattern",
            pattern: this.numberPattern(),
            help: "the number the service desk gave the request, such as SR-0042",
            required: true,
          },
          { name: "url", label: "Link to the request", format: "url", required: false },
        ],
      },
      a,
    );
    return this.fromStep(step);
  }
}
