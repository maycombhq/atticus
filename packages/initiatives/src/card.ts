import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  fileStepStore,
  ManualNotifier,
  type Notification,
  type StepStore,
} from "@maycombhq/adapters";
import type { CatalogRecord, ManualStep } from "@maycombhq/core";
import { addWorkingDays, dayOf, parseLeadTime } from "./dates.js";
import { systemOf } from "./plan.js";
import {
  initiativeDir,
  InitiativeError,
  manualEvidence,
  readView,
  writeCurated,
  type CatalogView,
  type CommitmentRecord,
} from "./store.js";

/**
 * "Request from a team" (the plan): send another team or a vendor a one-page system card —
 * what Atticus knows about their systems (what they offer, who calls them, what they call,
 * the data they own, their owners) and the questions still open — and ask them to correct and
 * answer it. The reply goes back into intake like any document (`atticus intake add`), where
 * every fact is checked against code; nothing on the card changes the catalog by itself. The
 * request is tracked as a Commitment with a due date from the party's typical lead time for
 * `system-card` (else five working days), and sending it is a manual step drafted through the
 * notifications adapter (manual, so a person sends it; approval rules unchanged).
 */

/** Plain code-point order, the same on every machine (no locale rules). */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const op = (method: string | undefined, path: string) => (method ? `${method} ${path}` : path);

function table(header: string[], rows: string[][]): string[] {
  if (!rows.length) return ["None known."];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ];
}

export interface CardContext {
  /** Lines under the title: who is asked, by whom, by when. */
  header?: string[];
}

/** The system card for some systems, as Markdown, from the catalog only. */
export function systemCard(view: CatalogView, systems: string[], o: CardContext = {}): string {
  const sys = systems
    .map((s) => view.get("System", s))
    .filter((s): s is NonNullable<typeof s> => !!s);
  if (!sys.length)
    throw new InitiativeError(
      `None of ${systems.join(", ")} is a system in the catalog.`,
      "not-found",
    );
  const ids = new Set(sys.map((s) => s.id));
  const inSys = (id: string) => {
    const s = systemOf(view, id);
    return s !== undefined && ids.has(s);
  };
  // Components of the card's own systems go by id; others carry their system's name.
  const label = (id: string) => {
    if (inSys(id)) return id;
    const s = systemOf(view, id);
    const name = s ? view.get("System", s)?.name : undefined;
    return s && s !== id && name ? `${id} (${name})` : id;
  };
  const title = sys.map((s) => s.name).join(", ");
  const L: string[] = [`# System card: ${title}`, ""];
  if (o.header?.length) L.push(...o.header, "");
  L.push(
    "Please check what we know about your system, correct anything that is wrong, and answer the open questions. Your reply goes into our intake as a document; nothing here changes without a person reviewing it.",
    "",
    "## Systems",
    "",
    ...table(
      ["System", "Boundary", "Owner", "Repos"],
      sys.map((s) => [
        `${s.name} (${s.id})`,
        s.boundary,
        s.owner ?? "unknown",
        s.repos.join(", ") || "none",
      ]),
    ),
    "",
  );
  const comps = view
    .all("Component")
    .filter((c) => ids.has(c.system))
    .sort((a, b) => cmp(a.id, b.id));
  if (comps.length)
    L.push(
      "## Components",
      "",
      ...table(
        ["Component", "Type", "Repo"],
        comps.map((c) => [c.id, c.type, c.repo ?? "unknown"]),
      ),
      "",
    );
  const endpoints = view
    .all("Endpoint")
    .filter((e) => inSys(e.component))
    .sort((a, b) => cmp(a.id, b.id));
  L.push(
    "## What it offers",
    "",
    ...table(
      ["Endpoint", "Type", "Operation"],
      endpoints.map((e) => [e.id, e.endpointType, op(e.method, e.pathOrTopic)]),
    ),
    "",
  );
  const ifs = view.all("Interface").filter((i) => i.status !== "retired");
  const row = (i: (typeof ifs)[number]) => [
    label(i.from),
    label(i.to),
    i.via,
    op(i.method, i.normalizedPath),
    i.sync,
  ];
  const byPath = (a: (typeof ifs)[number], b: (typeof ifs)[number]) =>
    cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.normalizedPath, b.normalizedPath);
  L.push(
    "## Who calls it",
    "",
    ...table(
      ["From", "To", "Via", "Operation", "Sync"],
      ifs
        .filter((i) => inSys(i.to) && !inSys(i.from))
        .sort(byPath)
        .map(row),
    ),
    "",
    "## What it calls",
    "",
    ...table(
      ["From", "To", "Via", "Operation", "Sync"],
      ifs
        .filter((i) => inSys(i.from) && !inSys(i.to))
        .sort(byPath)
        .map(row),
    ),
    "",
  );
  const stores = view
    .all("DataStore")
    .filter((d) => d.ownerComponent && inSys(d.ownerComponent))
    .sort((a, b) => cmp(a.id, b.id));
  const tables = view.all("Table").filter((t) => stores.some((s) => s.id === t.dataStore));
  L.push(
    "## Data it owns",
    "",
    ...table(
      ["Store", "Type", "Tables"],
      stores.map((s) => [
        s.id,
        s.storeType,
        tables
          .filter((t) => t.dataStore === s.id)
          .map((t) => t.id)
          .sort()
          .join(", ") || "none known",
      ]),
    ),
    "",
  );
  const questions = view
    .all("OwnerQuestion")
    .filter((q) => ids.has(q.system) && q.questionState !== "answered")
    .sort((a, b) => cmp(a.id, b.id));
  L.push("## Open questions", "");
  if (questions.length)
    for (const q of questions)
      L.push(
        `- (${q.id}) ${q.question} Needed: ${q.neededFact}. Asked of: ${q.owner} (${q.questionState})`,
      );
  else L.push("None recorded.");
  L.push(
    "",
    "## How to reply",
    "",
    "Reply in any form: edit this page, send a document or an e-mail. The reply is saved into the metarepo with `atticus intake add <file>`; it is read like any other document and every fact in it is checked against code.",
    "",
  );
  return L.join("\n");
}

export interface RequestFromTeamOptions {
  by: string;
  now?: Date;
  /** Default: the party's systems the initiative touches, else all its systems. */
  systems?: string[];
  /** Where manual steps are kept (default: files in the metarepo). */
  steps?: StepStore;
}

export interface RequestFromTeamResult {
  card: string;
  /** Path of the card, relative to the metarepo. */
  cardPath: string;
  commitment: CommitmentRecord;
  notification: Notification;
  step: ManualStep;
  written: string[];
}

const nowIso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export async function requestFromTeam(
  root: string,
  initiativeId: string,
  partyId: string,
  o: RequestFromTeamOptions,
): Promise<RequestFromTeamResult> {
  const now = o.now ?? new Date();
  const today = dayOf(now);
  const by = o.by.replace(/^@/, "");
  const view = await readView(root);
  const initiative = view.get("Initiative", initiativeId);
  if (!initiative)
    throw new InitiativeError(`There is no initiative ${initiativeId}.`, "not-found");
  const party = view.get("Party", partyId);
  if (!party) throw new InitiativeError(`There is no party ${partyId}.`, "not-found");
  const systems = o.systems ?? party.systems;
  if (!systems.length)
    throw new InitiativeError(
      `Party ${partyId} names no systems; add them to its record or pass --system.`,
      "usage",
    );
  const raw = party.typicalLeadTimes["system-card"];
  const days = (raw ? parseLeadTime(raw) : undefined) ?? 5;
  const due = addWorkingDays(today, days);
  const slug = partyId.replace(/^party\./, "");
  const cardRel = `initiatives/${initiativeId}/requests/${slug}.md`;
  const card = systemCard(view, systems, {
    header: [
      `For: ${initiative.title} (initiative ${initiative.id})`,
      `Asked of: ${party.name} (${party.id}), by ${by} on ${today}`,
      `Reply by: ${due}`,
    ],
  });
  const cardFile = join(initiativeDir(root, initiativeId), "requests", `${slug}.md`);
  await mkdir(dirname(cardFile), { recursive: true });
  await writeFile(cardFile, card, "utf8");

  const commitment: CommitmentRecord = {
    schemaVersion: 2,
    kind: "Commitment",
    id: `${initiativeId}.request.${slug}`,
    status: "current",
    confidence: "asserted",
    evidence: manualEvidence(by),
    initiative: initiative.id,
    party: party.id,
    what: `${party.name} replies to the system card for ${systems.join(", ")}`,
    owner: party.owner ?? party.name,
    neededBy: due,
    blocks: [...initiative.changes],
    commitmentStatus: "open",
  };
  const written = [cardRel, await writeCurated(root, commitment as CatalogRecord)];
  const updated = {
    ...initiative,
    parties: [...new Set([...initiative.parties, party.id])],
    commitments: [...new Set([...initiative.commitments, commitment.id])],
  };
  written.push(await writeCurated(root, updated as CatalogRecord));

  const notification: Notification = {
    channel: party.channel ?? "email",
    title: `System card: ${systems.join(", ")} (reply by ${due})`,
    body: [
      `Hello ${party.name},`,
      "",
      `For ${initiative.title} we need you to check what we know about ${systems.join(", ")} and answer the open questions on the attached system card by ${due}.`,
      "Reply in any form; we take your reply in as a document and check every fact against code.",
      "",
      `Sent by ${by}.`,
    ].join("\n"),
    link: cardRel,
    ...(party.contacts.length ? { mentions: party.contacts } : {}),
  };
  const store = o.steps ?? fileStepStore(root);
  const notifier = new ManualNotifier({ store, root, now: () => nowIso(now) });
  const sent = await notifier.send(notification, { by, at: nowIso(now), ref: commitment.id });
  const stepId = sent.id.replace(/^manual:/, "");
  const step = (await store.get(stepId))!;
  written.push(`steps/${step.id}.yaml`);
  return { card, cardPath: cardRel, commitment, notification, step, written };
}
