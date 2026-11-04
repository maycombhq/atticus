/**
 * The Agent Client Protocol, client side (ADR 0171): JSON-RPC 2.0, one JSON object a line, over a
 * child's stdin and stdout. This is the one file that knows the protocol's method names and
 * field names, written from the public ACP specification (protocol version 1) because no copy of
 * the protocol's SDK or schema is available offline here. If the GitHub Copilot language server
 * names something differently, this file is where it is put right; everything else talks to
 * `AcpClient` and the types below.
 *
 * Assumed from the specification (to check against the real server, ADR 0171 "What to check"):
 * - client → agent requests: `initialize` {protocolVersion, clientCapabilities: {fs:
 *   {readTextFile, writeTextFile}, terminal}, clientInfo} → {protocolVersion, agentCapabilities,
 *   authMethods, agentInfo?: {name, version}}; `session/new` {cwd, mcpServers: []} → {sessionId,
 *   models?: {currentModelId, availableModels: [{modelId, name}]}}; `session/set_model`
 *   {sessionId, modelId} (unstable in the specification); `session/prompt` {sessionId, prompt:
 *   [{type: "text", text}]} → {stopReason, usage?};
 * - client → agent notification: `session/cancel` {sessionId};
 * - agent → client notification: `session/update` {sessionId, update: {sessionUpdate: kind, ...}};
 * - agent → client requests: `session/request_permission` {sessionId, toolCall, options:
 *   [{optionId, name, kind}]} → {outcome: {outcome: "selected", optionId} | {outcome:
 *   "cancelled"}}; `fs/read_text_file` {sessionId, path, line?, limit?} → {content};
 *   `fs/write_text_file` {sessionId, path, content} → null; `terminal/create` {sessionId,
 *   command, args?, env?, cwd?, outputByteLimit?} → {terminalId}; `terminal/output` →
 *   {output, truncated, exitStatus?}; `terminal/wait_for_exit` → {exitCode, signal};
 *   `terminal/kill`, `terminal/release` → null;
 * - not signed in: an error with code -32000 ("auth required") from `session/new` or `prompt`.
 * Atticus never calls `authenticate`: a person signs in to Copilot themselves.
 */

export const ACP_PROTOCOL_VERSION = 1;

export const ACP_METHODS = {
  initialize: "initialize",
  authenticate: "authenticate",
  sessionNew: "session/new",
  sessionSetModel: "session/set_model",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionUpdate: "session/update",
  requestPermission: "session/request_permission",
  readTextFile: "fs/read_text_file",
  writeTextFile: "fs/write_text_file",
  terminalCreate: "terminal/create",
  terminalOutput: "terminal/output",
  terminalWaitForExit: "terminal/wait_for_exit",
  terminalKill: "terminal/kill",
  terminalRelease: "terminal/release",
} as const;

/** JSON-RPC's own codes, and ACP's "authentication required". */
export const ACP_ERRORS = {
  invalidParams: -32602,
  methodNotFound: -32601,
  internal: -32603,
  authRequired: -32000,
} as const;

export interface AcpTransport {
  /** Send one message (the transport adds the line end). */
  send(text: string): void;
  onLine(fn: (line: string) => void): void;
  onClose(fn: (why: string) => void): void;
}

export class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpRpcError";
  }
}

export interface InitializeResult {
  protocolVersion?: number;
  agentCapabilities?: Record<string, unknown>;
  authMethods?: { id: string; name?: string; description?: string | null }[];
  agentInfo?: { name?: string; title?: string; version?: string };
}

export interface NewSessionResult {
  sessionId: string;
  models?: { currentModelId?: string; availableModels?: { modelId: string; name?: string }[] };
}

export interface PromptResult {
  stopReason: string;
  usage?: Record<string, unknown>;
}

/** One location a tool call names. */
export interface AcpLocation {
  path: string;
  line?: number;
}

export interface AcpToolCall {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  locations?: AcpLocation[];
  rawInput?: unknown;
}

export interface PermissionOption {
  optionId: string;
  name?: string;
  kind: string;
}

/** What the agent may ask of the client; each answers or throws (the agent sees the message). */
export interface AcpClientHandlers {
  readTextFile(p: { path: string; line?: number; limit?: number }): Promise<{ content: string }>;
  writeTextFile(p: { path: string; content: string }): Promise<null>;
  requestPermission(p: {
    toolCall: AcpToolCall;
    options: PermissionOption[];
  }): Promise<{ outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } }>;
  terminalCreate(p: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: { name: string; value: string }[];
    outputByteLimit?: number;
  }): Promise<{ terminalId: string }>;
  terminalOutput(p: { terminalId: string }): Promise<{
    output: string;
    truncated: boolean;
    exitStatus?: { exitCode: number | null; signal: string | null };
  }>;
  terminalWaitForExit(p: {
    terminalId: string;
  }): Promise<{ exitCode: number | null; signal: string | null }>;
  terminalKill(p: { terminalId: string }): Promise<null>;
  terminalRelease(p: { terminalId: string }): Promise<null>;
  /** A session/update notification. */
  update(u: Record<string, unknown> & { sessionUpdate?: string }): void;
}

/** One message, either way, as the run's transcript keeps it. */
export type AcpTap = (dir: "in" | "out", message: unknown) => void;

/**
 * The client end of one connection: requests out with ids, answers matched back, the agent's
 * requests to the handlers. A message that isn't JSON is noted on the tap and ignored.
 */
export class AcpClient {
  private next = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private closed?: string;

  constructor(
    private readonly t: AcpTransport,
    private readonly h: AcpClientHandlers,
    private readonly tap: AcpTap = () => {},
  ) {
    t.onLine((line) => this.receive(line));
    t.onClose((why) => {
      this.closed = why;
      for (const p of this.pending.values()) p.reject(new AcpRpcError(ACP_ERRORS.internal, why));
      this.pending.clear();
    });
  }

  private out(message: Record<string, unknown>) {
    const m = { jsonrpc: "2.0", ...message };
    this.tap("out", m);
    this.t.send(JSON.stringify(m));
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new AcpRpcError(ACP_ERRORS.internal, this.closed));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.out({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) this.out({ method, params });
  }

  private receive(line: string) {
    if (!line.trim()) return;
    let m: {
      id?: number | string;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
    try {
      m = JSON.parse(line) as typeof m;
    } catch {
      this.tap("in", { notJson: line.slice(0, 500) });
      return;
    }
    this.tap("in", m);
    if (m.method === undefined && m.id !== undefined) {
      const p = this.pending.get(Number(m.id));
      if (!p) return;
      this.pending.delete(Number(m.id));
      if (m.error) p.reject(new AcpRpcError(m.error.code, m.error.message, m.error.data));
      else p.resolve(m.result ?? null);
      return;
    }
    if (m.method === ACP_METHODS.sessionUpdate) {
      const u = m.params?.update;
      if (u && typeof u === "object") this.h.update(u as Record<string, unknown>);
      return;
    }
    if (m.id === undefined) return;
    const id = m.id;
    void this.answer(m.method ?? "", m.params ?? {}).then(
      (result) => this.out({ id, result }),
      (e: unknown) =>
        this.out({
          id,
          error: {
            code: e instanceof AcpRpcError ? e.code : ACP_ERRORS.invalidParams,
            message: (e as Error).message,
          },
        }),
    );
  }

  private answer(method: string, p: Record<string, unknown>): Promise<unknown> {
    const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
    switch (method) {
      case ACP_METHODS.readTextFile:
        return this.h.readTextFile({
          path: s("path"),
          ...(typeof p.line === "number" ? { line: p.line } : {}),
          ...(typeof p.limit === "number" ? { limit: p.limit } : {}),
        });
      case ACP_METHODS.writeTextFile:
        return this.h.writeTextFile({ path: s("path"), content: s("content") });
      case ACP_METHODS.requestPermission:
        return this.h.requestPermission({
          toolCall: (p.toolCall ?? {}) as AcpToolCall,
          options: Array.isArray(p.options) ? (p.options as PermissionOption[]) : [],
        });
      case ACP_METHODS.terminalCreate:
        return this.h.terminalCreate({
          command: s("command"),
          ...(Array.isArray(p.args) ? { args: (p.args as unknown[]).map(String) } : {}),
          ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
          ...(Array.isArray(p.env) ? { env: p.env as { name: string; value: string }[] } : {}),
          ...(typeof p.outputByteLimit === "number" ? { outputByteLimit: p.outputByteLimit } : {}),
        });
      case ACP_METHODS.terminalOutput:
        return this.h.terminalOutput({ terminalId: s("terminalId") });
      case ACP_METHODS.terminalWaitForExit:
        return this.h.terminalWaitForExit({ terminalId: s("terminalId") });
      case ACP_METHODS.terminalKill:
        return this.h.terminalKill({ terminalId: s("terminalId") });
      case ACP_METHODS.terminalRelease:
        return this.h.terminalRelease({ terminalId: s("terminalId") });
      default:
        return Promise.reject(
          new AcpRpcError(ACP_ERRORS.methodNotFound, `Atticus doesn't offer ${method}`),
        );
    }
  }

  // ------------------------------------------------------------ the agent's methods

  initialize(clientInfo: { name: string; version: string }): Promise<InitializeResult> {
    return this.request<InitializeResult>(ACP_METHODS.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo,
    });
  }

  newSession(cwd: string): Promise<NewSessionResult> {
    // No MCP servers: the session gets only the files and the terminal this client offers.
    return this.request<NewSessionResult>(ACP_METHODS.sessionNew, { cwd, mcpServers: [] });
  }

  setModel(sessionId: string, modelId: string): Promise<unknown> {
    return this.request(ACP_METHODS.sessionSetModel, { sessionId, modelId });
  }

  prompt(sessionId: string, text: string): Promise<PromptResult> {
    return this.request<PromptResult>(ACP_METHODS.sessionPrompt, {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  cancel(sessionId: string): void {
    this.notify(ACP_METHODS.sessionCancel, { sessionId });
  }
}

/** The text of a message chunk update, when it is text. */
export function chunkText(u: Record<string, unknown>): string | undefined {
  const c = u.content as { type?: string; text?: string } | undefined;
  return c?.type === "text" && typeof c.text === "string" ? c.text : undefined;
}

/** The update kinds the client reads (the rest are noted in the transcript only). */
export const UPDATE = {
  message: "agent_message_chunk",
  thought: "agent_thought_chunk",
  toolCall: "tool_call",
  toolCallUpdate: "tool_call_update",
  plan: "plan",
} as const;

/** Tokens a prompt answer reports, in either spelling; undefined when it says none. */
export function usageOf(
  u: Record<string, unknown> | undefined,
): { inputTokens: number; outputTokens: number } | undefined {
  if (!u) return undefined;
  const n = (...ks: string[]) => {
    for (const k of ks) if (typeof u[k] === "number") return u[k] as number;
    return undefined;
  };
  const i = n("inputTokens", "input_tokens", "promptTokens");
  const o = n("outputTokens", "output_tokens", "completionTokens");
  return i === undefined && o === undefined
    ? undefined
    : {
        inputTokens: Math.max(0, Math.round(i ?? 0)),
        outputTokens: Math.max(0, Math.round(o ?? 0)),
      };
}

/** Whether an error says the server isn't signed in. */
export const isAuthRequired = (e: unknown) =>
  e instanceof AcpRpcError &&
  (e.code === ACP_ERRORS.authRequired || /auth|sign.?in|log.?in/i.test(e.message));
