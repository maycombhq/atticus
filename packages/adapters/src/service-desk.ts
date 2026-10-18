import { AdapterError, MockBase, requireApproval, type Approval } from "./common.js";

/** ServiceNow and the like: firewall, access, certificate and change requests. */
export type RequestState = "draft" | "submitted" | "in-progress" | "done" | "rejected";

export interface ServiceRequest {
  id: string;
  type: string;
  state: RequestState;
  fields: Record<string, string | number>;
  changeId?: string;
  approvalGroup?: string;
  openedAt?: string;
  closedAt?: string;
  url: string;
}

export interface RequestDraft {
  templateId: string;
  type: string;
  fields: Record<string, string | number>;
  changeId: string;
}

export interface ServiceDesk {
  getRequest(id: string): Promise<ServiceRequest>;
  listRequests(q: {
    changeId?: string;
    state?: RequestState;
    type?: string;
  }): Promise<ServiceRequest[]>;
  /** A person submits (the delivery lead, by default); Atticus never files requests on its own. */
  submitRequest(draft: RequestDraft, approval: Approval): Promise<ServiceRequest>;
}

export class MockServiceDesk extends MockBase implements ServiceDesk {
  private requests = new Map<string, ServiceRequest>();
  private next = 1;

  constructor(seed: ServiceRequest[] = []) {
    super("service-desk");
    for (const r of seed) this.requests.set(r.id, { ...r });
    this.next = seed.length + 1;
  }

  /** Load the shape the fixture's closed-requests export uses. */
  static fromExport(
    rows: {
      type: string;
      number: string;
      fields: Record<string, string | number>;
      opened?: string;
      closed?: string;
      approvalGroup?: string;
    }[],
  ): MockServiceDesk {
    return new MockServiceDesk(
      rows.map((r) => ({
        id: r.number,
        type: r.type,
        state: r.closed ? "done" : "submitted",
        fields: r.fields,
        ...(r.approvalGroup ? { approvalGroup: r.approvalGroup } : {}),
        ...(r.opened ? { openedAt: r.opened } : {}),
        ...(r.closed ? { closedAt: r.closed } : {}),
        url: `https://desk.example.com/requests/${r.number}`,
      })),
    );
  }

  async getRequest(id: string) {
    this.call("getRequest", [id]);
    return { ...(this.requests.get(id) ?? this.notFound(`request ${id}`)) };
  }

  async listRequests(q: { changeId?: string; state?: RequestState; type?: string }) {
    this.call("listRequests", [q]);
    return [...this.requests.values()]
      .filter(
        (r) =>
          (!q.changeId || r.changeId === q.changeId) &&
          (!q.state || r.state === q.state) &&
          (!q.type || r.type === q.type),
      )
      .map((r) => ({ ...r }));
  }

  async submitRequest(draft: RequestDraft, approval: Approval) {
    const a = requireApproval(this.name, approval);
    this.call("submitRequest", [draft], a);
    const empty = Object.entries(draft.fields)
      .filter(([, v]) => v === "")
      .map(([k]) => k);
    if (empty.length > 0)
      throw new AdapterError(
        this.name,
        "invalid",
        `required fields are empty: ${empty.join(", ")}`,
      );
    const id = `SR-${String(this.next++).padStart(4, "0")}`;
    const r: ServiceRequest = {
      id,
      type: draft.type,
      state: "submitted",
      fields: { ...draft.fields },
      changeId: draft.changeId,
      openedAt: a.at.slice(0, 10),
      url: `https://desk.example.com/requests/${id}`,
    };
    this.requests.set(id, r);
    return { ...r };
  }

  /** Test helper: move a request along as the service desk would. */
  setState(id: string, state: RequestState, closedAt?: string): void {
    const r = this.requests.get(id) ?? this.notFound(`request ${id}`);
    r.state = state;
    if (closedAt) r.closedAt = closedAt;
  }
}
