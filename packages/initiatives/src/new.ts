import type { CatalogRecord } from "@maycombhq/core";
import { isIsoDay } from "./dates.js";
import { JOURNEYS, type JourneyId } from "./journeys.js";
import {
  InitiativeError,
  manualEvidence,
  readView,
  slugOf,
  writeCurated,
  type InitiativeRecord,
  type PartyRecord,
} from "./store.js";

export interface NewInitiativeOptions {
  title: string;
  journey: string;
  /** Who starts it: recorded as the manual evidence of the record. */
  by: string;
  /** Default: a slug of the title. */
  id?: string;
  /** YYYY-MM-DD. */
  targetRelease?: string;
  adoEpic?: string;
}

/**
 * Start an initiative: an Initiative record (C1) in the catalog's curated area, asserted by
 * the person who started it, with no changes, parties or commitments yet. `planJourney` fills
 * those in. Refuses an id that is already taken.
 */
export async function newInitiative(
  root: string,
  o: NewInitiativeOptions,
): Promise<{ initiative: InitiativeRecord; written: string }> {
  if (!(JOURNEYS as readonly string[]).includes(o.journey))
    throw new InitiativeError(
      `There is no journey ${o.journey}. Journeys: ${JOURNEYS.join(", ")}.`,
      "usage",
    );
  if (!o.title.trim()) throw new InitiativeError("An initiative needs a title.", "usage");
  if (o.targetRelease && !isIsoDay(o.targetRelease))
    throw new InitiativeError("Give the target release as YYYY-MM-DD.", "usage");
  const id = o.id ?? slugOf(o.title);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id))
    throw new InitiativeError(
      `${id} is not a valid id (lowercase letters, digits, ".", "_" and "-").`,
      "usage",
    );
  const view = await readView(root);
  if (view.get("Initiative", id))
    throw new InitiativeError(`An initiative ${id} already exists.`, "exists");
  const initiative: InitiativeRecord = {
    schemaVersion: 2,
    kind: "Initiative",
    id,
    status: "current",
    confidence: "asserted",
    evidence: manualEvidence(o.by),
    title: o.title.trim(),
    journey: o.journey as JourneyId,
    changes: [],
    parties: [],
    commitments: [],
    ...(o.targetRelease ? { targetRelease: o.targetRelease } : {}),
    ...(o.adoEpic ? { adoEpic: o.adoEpic } : {}),
  };
  const written = await writeCurated(root, initiative as CatalogRecord);
  return { initiative, written };
}

export interface NewPartyOptions {
  id: string;
  name: string;
  partyKind: "internal-team" | "vendor";
  by: string;
  owner?: string;
  contacts?: string[];
  channel?: string;
  systems?: string[];
  typicalLeadTimes?: Record<string, string>;
}

/** Record a party (an internal team or a vendor) as a curated Party record. */
export async function addParty(
  root: string,
  o: NewPartyOptions,
): Promise<{ party: PartyRecord; written: string }> {
  const party: PartyRecord = {
    schemaVersion: 2,
    kind: "Party",
    id: o.id,
    status: "current",
    confidence: "asserted",
    evidence: manualEvidence(o.by),
    name: o.name,
    partyKind: o.partyKind,
    ...(o.owner ? { owner: o.owner } : {}),
    contacts: o.contacts ?? [],
    ...(o.channel ? { channel: o.channel } : {}),
    systems: o.systems ?? [],
    // ADR 0101's fields for a team or vendor read from a page; a party recorded here has none.
    responsibilities: [],
    owns: [],
    uses: [],
    aliases: [],
    tags: [],
    alsoOn: [],
    urls: [],
    typicalLeadTimes: o.typicalLeadTimes ?? {},
  };
  return { party, written: await writeCurated(root, party as CatalogRecord) };
}
