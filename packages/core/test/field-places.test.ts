import { describe, expect, it } from "vitest";
import {
  declaredTypeOf,
  looseFieldClasses,
  placeFields,
  type Fact,
  type FactOf,
} from "../src/index.js";

/**
 * A field's place from the facts (ADR 0164, addendum of 2026-11-17): the type a cited line
 * declares, in the forms the languages write it, and the classes of the invented Forge payloads.
 */

type Field = FactOf<"field">;
let n = 0;
const field = (
  file: string,
  name: string,
  more: Partial<Field> & { quote?: string } = {},
): Field => {
  const { quote, ...rest } = more;
  return {
    kind: "field",
    id: `field.${file.split("/").pop()!.split(".")[0]!.toLowerCase()}.${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
    repo: "forge-desk",
    commit: "d4d0001",
    owner: "entry.get.cases",
    side: "response",
    name,
    cite: { file, line: ++n, value: name, ...(quote ? { quote } : {}) },
    verified: "line",
    by: "assistant",
    conf: "declared",
    ...rest,
  } as Field;
};
const typeOf = (name: string, quote: string, value = name) =>
  declaredTypeOf({ name, cite: { file: "x", line: 1, value, quote } });

describe("the type a cited line declares", () => {
  it.each([
    ["stamps", "private List<Stamp> stamps = null;", "List<Stamp>"],
    ["stamps", "private Stamp[] stamps;", "Stamp[]"],
    ["owner", "private Optional<CaseOwner> owner;", "Optional<CaseOwner>"],
    ["notes", "private Map<String, CaseNote> notes;", "Map<String, CaseNote>"],
    ["owner", "private final CaseOwner owner;", "CaseOwner"],
    ["depot_token", '@JsonProperty("depot_token") private UUID depotToken;', "UUID"],
    [
      "amount",
      "public record PaymentRequest(String accountId, Money amount, String memo) {}",
      "Money",
    ],
    ["Statuses", "public List<CaseStatus> Statuses { get; set; }", "List<CaseStatus>"],
    ["Owner", "public CaseOwner? Owner { get; init; }", "CaseOwner?"],
    ["stamps", "val stamps: List<CaseStatus>? = null,", "List<CaseStatus>?"],
    ["stamps", "stamps?: CaseStatus[];", "CaseStatus[]"],
    ["owner", "readonly owner: CaseOwner | null;", "CaseOwner | null"],
    ["stamps", "stamps: list[CaseStatus] = []", "list[CaseStatus]"],
    ["stamps", 'Stamps []CaseStatus `json:"stamps"`', "[]CaseStatus"],
    ["owner", 'Owner *CaseOwner `json:"owner"`', "*CaseOwner"],
  ])("%s in `%s` is %s", (name, quote, want) => {
    expect(typeOf(name, quote)).toBe(want);
  });

  it("is nothing where the line declares none, and the fact's own type wins", () => {
    expect(typeOf("receipt", '@JsonProperty("receipt")')).toBeUndefined();
    expect(typeOf("status", "return view.status();")).toBeUndefined();
    expect(
      declaredTypeOf({
        name: "a",
        type: "Money",
        cite: { file: "x", line: 1, value: "a", quote: "String a;" },
      }),
    ).toBe("Money");
  });
});

describe("classes and their places", () => {
  const names = (fields: Field[]) => {
    const p = placeFields(fields, "response");
    return fields.flatMap((f) => p.of(f).map((x) => `${x.name}${x.unplaced ? " ?" : ""}`)).sort();
  };

  it("a list gives [], several levels compose, a header stays out", () => {
    const fields = [
      field("src/Case.java", "owner", { type: "CaseOwner" }),
      field("src/Case.java", "notes", { quote: "private List<CaseNote> notes;" }),
      field("src/CaseOwner.java", "team", { type: "Team" }),
      field("src/Team.java", "name", { type: "String" }),
      field("src/CaseNote.java", "text", { type: "String" }),
      field("src/CaseClient.java", "X-Request-Id", { type: "String" }),
    ];
    expect(names(fields)).toEqual([
      "X-Request-Id",
      "notes",
      "notes[].text",
      "owner",
      "owner.team",
      "owner.team.name",
    ]);
  });

  it("several classes in one file are told by the ids that carry a type's name", () => {
    const fields = [
      field("src/models.py", "owner", { id: "field.case.owner", type: "CaseOwner" }),
      field("src/models.py", "title", { id: "field.case.title", type: "str" }),
      field("src/models.py", "team", { id: "field.case-owner.team", type: "str" }),
    ];
    expect(names(fields)).toEqual(["owner", "owner.team", "title"]);
  });

  it("a class held in a map has no place anyone can name", () => {
    const fields = [
      field("src/Case.java", "notes", { type: "Map<String, CaseNote>" }),
      field("src/CaseNote.java", "text", { type: "String" }),
    ];
    expect(names(fields)).toEqual(["notes", "notes.text ?"]);
  });

  it("a flat payload cited in several files, none holding another, is as written", () => {
    const fields = [
      field("src/OrderView.java", "id", { type: "String" }),
      field("src/OrderMapper.java", "total", { type: "BigDecimal" }),
    ];
    expect(names(fields)).toEqual(["id", "total"]);
  });

  it("looseFieldClasses names the class, its file, its fields and why", () => {
    const call = {
      kind: "entry",
      id: "entry.get.cases",
      repo: "forge-desk",
      commit: "d4d0001",
      entryType: "rest",
      method: "GET",
      path: "/cases",
      cite: { file: "src/CaseController.java", line: 3, value: "/cases" },
      verified: "line",
      by: "assistant",
      conf: "declared",
    } as Fact;
    const fields = [
      field("src/Case.java", "owner", { type: "CaseOwner" }),
      field("src/CaseOwner.java", "team", { type: "String" }),
      field("src/CaseNote.java", "text", { type: "String" }),
    ];
    expect(looseFieldClasses([call, ...fields])).toEqual([
      {
        owner: "entry.get.cases",
        side: "response",
        class: "CaseNote",
        file: "src/CaseNote.java",
        fields: ["field.casenote.text"],
        why: "CaseNote is not reached from the response's fields",
      },
    ]);
    expect(looseFieldClasses([call, ...fields].reverse())).toEqual(
      looseFieldClasses([call, ...fields]),
    );
  });
});
