import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Fact } from "@maycombhq/core";
import {
  declaredTypes,
  dirSource,
  isEntryPointFile,
  isModelFile,
  isRootFile,
  memorySource,
  planBatches,
  planParts,
  reachableModels,
  type FileTokens,
} from "../src/index.js";

/**
 * Reachable-first reading of model classes (ADR 0169): from a repo's entry points and the calls
 * it makes, the request, response and message classes their signatures and bodies name, and the
 * classes those name in turn, by text alone (no parser). The fixtures are invented Forge
 * services: forge-house (Java, Spring) and forge-appraise (Python, FastAPI), the second stack.
 */

const fixtures = join(__dirname, "..", "..", "..", "fixtures", "reachable");
const HOUSE = "src/main/java/forge/house";

const reachOf = (dir: string, facts?: Fact[]) => {
  const source = dirSource(join(fixtures, dir));
  return reachableModels({
    paths: source.list(),
    read: (p) => source.read(p),
    ...(facts ? { facts } : {}),
  });
};

describe("which files are models, entry points and clients (ADR 0169)", () => {
  it("knows a model class by its folder or its name, in any language", () => {
    for (const p of [
      `${HOUSE}/model/Address.java`,
      "src/main/kotlin/forge/house/dto/ListingDto.kt",
      "Forge.House/Contracts/Models/ListingModel.cs",
      "src/listings/dto/create-listing.dto.ts",
      "app/schemas/parcel.py",
      "internal/models/listing.go",
      "src/main/java/forge/house/api/ListingResponse.java",
      "src/main/java/forge/house/web/ListingRequest.java",
    ])
      expect(isModelFile(p), p).toBe(true);
    for (const p of [
      `${HOUSE}/api/HouseController.java`,
      `${HOUSE}/client/ValuationClient.java`,
      `${HOUSE}/service/ListingService.java`,
      "src/main/resources/application.yml",
      "app/schemas/openapi.yaml",
      "src/test/java/forge/house/model/AddressTest.java",
    ])
      expect(isModelFile(p), p).toBe(false);
  });

  it("never takes a class that maps a table for a model to leave out", () => {
    const entity = '@Entity\n@Table(name = "listing")\npublic class ListingModel {}\n';
    expect(isModelFile(`${HOUSE}/model/ListingModel.java`, entity)).toBe(false);
    expect(
      isModelFile("app/models/listing.py", "class Listing(Base):\n    __tablename__ = 'listing'\n"),
    ).toBe(false);
  });

  it("knows the entry points and clients the planner ranks, and no model among them", () => {
    expect(isRootFile(`${HOUSE}/api/HouseController.java`)).toBe(true);
    expect(isRootFile(`${HOUSE}/client/ValuationClient.java`)).toBe(true);
    expect(isRootFile("app/routers/appraisals.py")).toBe(true);
    expect(isRootFile("app/clients/county_client.py")).toBe(true);
    expect(isRootFile("src/events/LedgerPublisher.java")).toBe(true);
    expect(isRootFile(`${HOUSE}/service/ListingService.java`)).toBe(false);
    expect(isRootFile(`${HOUSE}/model/ListingRequest.java`)).toBe(false);
    expect(isRootFile("src/main/java/forge/house/api/ListingResponse.java")).toBe(false);
    expect(isEntryPointFile(`${HOUSE}/api/HouseController.java`)).toBe(true);
    expect(isEntryPointFile(`${HOUSE}/client/ValuationClient.java`)).toBe(false);
    expect(isEntryPointFile("src/main/resources/routes.yaml")).toBe(false);
  });

  it("reads the types a file declares with generic text patterns", () => {
    expect(declaredTypes("ListingRequest.java", "public class ListingRequest {")).toEqual([
      "ListingRequest",
    ]);
    expect(declaredTypes("listing.kt", "data class ListingDto(val id: String)")).toEqual([
      "ListingDto",
    ]);
    expect(declaredTypes("Listing.cs", "public sealed record ListingModel(string Id);")).toEqual([
      "Listing",
      "ListingModel",
    ]);
    expect(
      declaredTypes(
        "create-listing.dto.ts",
        "export interface CreateListingDto {\n  id: string;\n}\nexport type ListingId = string;\n",
      ),
    ).toEqual(["CreateListingDto", "ListingId"]);
    expect(declaredTypes("parcel.py", "class Parcel(BaseModel):\n    acres: float\n")).toEqual([
      "Parcel",
    ]);
    expect(declaredTypes("listing.go", "type Listing struct {\n\tID string\n}\n")).toEqual([
      "Listing",
    ]);
  });
});

describe("reachableModels from the source text (ADR 0169)", () => {
  it("follows the controller's and the client's types, and the classes they nest", () => {
    const r = reachOf("forge-house");
    expect(r.rooted).toBe(true);
    expect(r.roots).toEqual([
      `${HOUSE}/api/HouseController.java`,
      `${HOUSE}/client/ValuationClient.java`,
    ]);
    expect(r.reached.map((x) => [x.path, x.from])).toEqual([
      [`${HOUSE}/model/ListingRequest.java`, `${HOUSE}/api/HouseController.java`],
      [`${HOUSE}/model/ValuationResponse.java`, `${HOUSE}/api/HouseController.java`],
      [`${HOUSE}/model/Address.java`, `${HOUSE}/model/ListingRequest.java`],
    ]);
    expect(r.reached.map((x) => x.types)).toEqual([
      ["ListingRequest"],
      ["ValuationResponse"],
      ["Address"],
    ]);
    // a model only a service names, and one only an unreached model nests, are reached by nothing
    expect(r.notReached).toEqual(
      ["AgentProfile", "InspectionReport", "LegacyListing", "MortgageQuote", "OpenHouseSlot"].map(
        (n) => `${HOUSE}/model/${n}.java`,
      ),
    );
    expect(r.models).toBe(8);
  });

  it("does the same for a second stack: FastAPI routers, an httpx client and pydantic schemas", () => {
    const r = reachOf("forge-appraise");
    expect(r.roots).toEqual([
      "app/main.py",
      "app/routers/appraisals.py",
      "app/clients/county_client.py",
    ]);
    expect(r.reached.map((x) => [x.path, x.from])).toEqual([
      ["app/schemas/appraisal_request.py", "app/routers/appraisals.py"],
      ["app/schemas/appraisal_result.py", "app/routers/appraisals.py"],
      ["app/schemas/parcel.py", "app/clients/county_client.py"],
    ]);
    expect(r.notReached).toEqual(["app/schemas/survey_record.py", "app/schemas/zoning_note.py"]);
  });

  it("is deterministic: the same files give the same answer", () => {
    expect(reachOf("forge-house")).toEqual(reachOf("forge-house"));
  });

  it("leaves nothing out of a repo with no entry point or client (a library of models)", () => {
    const source = memorySource({
      "src/model/Listing.java": "public class Listing { private Address address; }\n",
      "src/model/Address.java": "public class Address { private String street; }\n",
    });
    const r = reachableModels({ paths: source.list(), read: (p) => source.read(p) });
    expect(r.rooted).toBe(false);
    expect(r.notReached).toEqual([]);
    expect(r.reached.map((x) => x.path)).toEqual([
      "src/model/Address.java",
      "src/model/Listing.java",
    ]);
  });

  it("follows TypeScript, Go, C# and Kotlin with the same patterns", () => {
    const source = memorySource({
      "src/listings/listings.controller.ts":
        "@Post() create(@Body() body: CreateListingDto): Promise<ListingView> {}\n",
      "src/listings/dto/create-listing.dto.ts":
        "export class CreateListingDto { address: AddressDto }\n",
      "src/listings/dto/address.dto.ts": "export class AddressDto { street: string }\n",
      "src/listings/dto/listing-view.dto.ts": "export interface ListingView { id: string }\n",
      "src/listings/dto/unused.dto.ts": "export class UnusedDto {}\n",
      "internal/handlers/listing_handler.go":
        "func Create(w http.ResponseWriter, r *http.Request) { var in models.Listing }\n",
      "internal/models/listing.go": "type Listing struct {\n\tOwner Owner\n}\n",
      "internal/models/owner.go": "type Owner struct {\n\tName string\n}\n",
      "internal/models/audit.go": "type Audit struct {}\n",
      "Forge.House/Controllers/HouseController.cs":
        "public IActionResult Post([FromBody] ListingModel m) {}\n",
      "Forge.House/Models/ListingModel.cs": "public record ListingModel(string Id);\n",
      "Forge.House/Models/LedgerModel.cs": "public record LedgerModel(string Id);\n",
      "src/main/kotlin/forge/house/HouseRoutes.kt": 'post<ListingDto>("/listings") { }\n',
      "src/main/kotlin/forge/house/dto/ListingDto.kt": "data class ListingDto(val id: String)\n",
      "src/main/kotlin/forge/house/dto/SpareDto.kt": "data class SpareDto(val id: String)\n",
    });
    const r = reachableModels({ paths: source.list(), read: (p) => source.read(p) });
    expect(r.reached.map((x) => x.path).sort()).toEqual(
      [
        "Forge.House/Models/ListingModel.cs",
        "internal/models/listing.go",
        "internal/models/owner.go",
        "src/listings/dto/address.dto.ts",
        "src/listings/dto/create-listing.dto.ts",
        "src/listings/dto/listing-view.dto.ts",
        "src/main/kotlin/forge/house/dto/ListingDto.kt",
      ].sort(),
    );
    expect(r.notReached).toEqual([
      "Forge.House/Models/LedgerModel.cs",
      "internal/models/audit.go",
      "src/listings/dto/unused.dto.ts",
      "src/main/kotlin/forge/house/dto/SpareDto.kt",
    ]);
  });
});

describe("reachableModels from the facts when the repo is read (ADR 0169)", () => {
  const cite = (file: string, line = 1) => ({ file, line, value: "x" });
  const base = {
    repo: "forge-house",
    commit: "0123abc",
    verified: "line",
    by: "assistant",
    conf: "declared",
  } as const;

  it("starts from the files the entries and calls cite and the types field facts name", () => {
    const facts = [
      {
        ...base,
        kind: "call",
        id: "call.valuations",
        callType: "rest",
        method: "POST",
        path: "/v1/valuations",
        cite: cite(`${HOUSE}/client/ValuationClient.java`, 15),
      },
      // a field fact naming a type as its own: that type's class is reached too
      {
        ...base,
        kind: "field",
        id: "field.slot",
        owner: "call.valuations",
        side: "response",
        name: "slot",
        type: "List<OpenHouseSlot>",
        cite: cite(`${HOUSE}/model/ValuationResponse.java`, 6),
      },
    ] as unknown as Fact[];
    const r = reachOf("forge-house", facts);
    const at = (p: string) => r.reached.find((x) => x.path === `${HOUSE}/model/${p}.java`);
    // the client a call cites comes first among the roots
    expect(r.roots[0]).toBe(`${HOUSE}/client/ValuationClient.java`);
    expect(at("OpenHouseSlot")?.from).toBe("field.slot");
    // a model file a kept fact cites was read: it is reached, from the facts
    expect(at("ValuationResponse")).toBeDefined();
    // the controller no fact cites is still read for its types
    expect(at("ListingRequest")).toBeDefined();
    expect(r.notReached).toEqual(
      ["AgentProfile", "InspectionReport", "LegacyListing", "MortgageQuote"].map(
        (n) => `${HOUSE}/model/${n}.java`,
      ),
    );
  });
});

describe("planning reachable first (ADR 0169)", () => {
  it("puts the entry points and clients first, then the reached models in order, and leaves the rest out", () => {
    const source = dirSource(join(fixtures, "forge-house"));
    const r = reachableModels({ paths: source.list(), read: (p) => source.read(p) });
    const plan = planBatches(source, {
      room: Number.MAX_SAFE_INTEGER,
      reach: { first: [...r.roots, ...r.reached.map((x) => x.path)], leaveOut: r.notReached },
    });
    const order = plan.batches.flat().map((s) => s.path);
    expect(order.slice(0, 2)).toEqual(["pom.xml", "src/main/resources/application.yml"]);
    expect(order.slice(2, 7)).toEqual([
      `${HOUSE}/api/HouseController.java`,
      `${HOUSE}/client/ValuationClient.java`,
      `${HOUSE}/model/ListingRequest.java`,
      `${HOUSE}/model/ValuationResponse.java`,
      `${HOUSE}/model/Address.java`,
    ]);
    expect(order.slice(7)).toEqual([`${HOUSE}/service/ListingService.java`]);
    expect(plan.notReached).toEqual(r.notReached);
    expect(plan.files).toBe(8);
  });

  it("plans parts with the entry points first, the reached models next, and no glob over a model left out", () => {
    const files: FileTokens[] = [
      { path: "pom.xml", tokens: 500 },
      { path: "src/api/HouseController.java", tokens: 4000 },
      { path: "src/client/ValuationClient.java", tokens: 4000 },
      ...Array.from({ length: 6 }, (_, i) => ({
        path: `src/model/Reached${i}.java`,
        tokens: 3000,
      })),
      ...Array.from({ length: 6 }, (_, i) => ({ path: `src/service/S${i}.java`, tokens: 1500 })),
    ];
    const leftOut = Array.from({ length: 30 }, (_, i) => `src/model/Unreached${i}.java`);
    const models = files
      .filter((f) => f.path.includes("/model/"))
      .map((f) => f.path)
      .reverse();
    const parts = planParts(files, 12_000, {
      head: ["pom.xml", "src/api/HouseController.java", "src/client/ValuationClient.java"],
      models,
      leftOut,
    });
    const paths = parts.flatMap((p) => p.paths);
    expect(paths.slice(0, 3)).toEqual(["*", "src/api/**", "src/client/**"]);
    // the reached models one by one, in reachability order, never as src/model/**
    expect(paths.slice(3, 9)).toEqual(models);
    expect(paths).not.toContain("src/model/**");
    expect(paths.at(-1)).toBe("src/service/**");
    for (const p of parts) expect(p.tokens).toBeLessThanOrEqual(12_000);
    expect(parts.reduce((n, p) => n + p.files, 0)).toBe(files.length);
  });

  it("plans as before when nothing is given", () => {
    const files: FileTokens[] = Array.from({ length: 4 }, (_, i) => ({
      path: `m${i}/A.java`,
      tokens: 60_000,
    }));
    expect(planParts(files, 100_000).map((p) => p.paths)).toEqual([
      ["m0/**"],
      ["m1/**"],
      ["m2/**"],
      ["m3/**"],
    ]);
  });
});
