import type { Screen } from "../registry.js";
import { Documents } from "./Documents.js";
import { KnowledgeItems } from "./Items.js";
import { OrgPackDraft } from "./OrgPackDraft.js";
import { Parties } from "./Parties.js";
import { WikiSearch } from "./Search.js";
import { KnowledgeSources } from "./Sources.js";

/** The knowledge screens (ADR 0102), under More in the Know group. */
export const KNOWLEDGE_SCREENS: Record<string, Screen> = {
  wikis: () => <KnowledgeSources />,
  documents: () => <Documents />,
  knowledge: KnowledgeItems,
  "wiki-search": WikiSearch,
  parties: () => <Parties />,
  "orgpack-draft": () => <OrgPackDraft />,
};
