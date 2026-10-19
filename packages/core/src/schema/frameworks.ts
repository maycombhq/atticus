import { z } from "zod";
import { RecordId } from "./common.js";

/**
 * Contract C6: a framework model, `org-pack/frameworks/<name>.yaml` (ADR 0054). What a house
 * framework (a starter, a platform library) means, in terms the built-in extractors already
 * read: its annotations as the built-in ones they stand for, its wrapper clients as HTTP calls,
 * its service ids and constants as values. Written by a person or learned (from source, JARs,
 * dependencies, documents); scans only read it.
 */
export const FRAMEWORK_SCHEMA_VERSION = 1 as const;

/** Where an entry was learned. code and bytecode can make verified facts; the others inferred ones. */
export const FrameworkSource = z.strictObject({
  kind: z.enum(["code", "bytecode", "document", "person"]),
  /** A repo path, artifact coordinates with a checksum, a page URL, a person's handle. */
  ref: z.string().min(1).optional(),
});
export type FrameworkSource = z.infer<typeof FrameworkSource>;

const SimpleName = z.string().regex(/^[A-Za-z_$][\w$]*$/, "a simple Java name such as InternalApi");
const QualifiedName = z
  .string()
  .regex(/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/, "a qualified name such as Services.AUDIT");

export const FrameworkAnnotation = z.strictObject({
  /** The house annotation's simple name: InternalApi. */
  name: SimpleName,
  /**
   * The annotations it stands for, by simple name: [RestController, RequestMapping]. Each
   * extractor reads the ones it knows (its framework's own); the contract names none.
   */
  means: z.array(SimpleName).min(1),
  /** Its attribute names onto the built-in ones: { basePath: path, verb: method }. */
  attributes: z.record(z.string(), z.string()).default({}),
  /** Fixed attributes the built-in ones get whatever is written: { method: GET }. */
  fixed: z.record(z.string(), z.string()).default({}),
  source: FrameworkSource,
});

/** One argument of a wrapper call: its position, or a fixed value. */
const CallPart = z.union([
  z.strictObject({ arg: z.number().int().min(0) }),
  z.strictObject({ value: z.string().min(1) }),
]);

export const FrameworkClient = z.strictObject({
  /** The wrapper's type (simple name): BankHttp. Fields and variables of this type are its receivers. */
  type: SimpleName,
  /** The method that makes the call: exchange. */
  method: SimpleName,
  /** The HTTP method: a fixed value or an argument (POST, or { arg: 1 }). */
  httpMethod: CallPart,
  /** The service id the call goes to, looked up in services, when there is one. */
  service: CallPart.optional(),
  /** The path (with service) or the whole URL. */
  path: CallPart,
  source: FrameworkSource,
});

export const FrameworkValue = z.strictObject({
  value: z.string(),
  source: FrameworkSource,
});

export const FrameworkModel = z.strictObject({
  schemaVersion: z.literal(FRAMEWORK_SCHEMA_VERSION),
  name: RecordId,
  /** Import prefixes that mark a file as using the framework: tide.platform. */
  packages: z.array(z.string().regex(/^[a-z][\w]*(\.[\w]+)*$/, "a package prefix")).min(1),
  /** The artifacts it ships as, when known: tide.platform:tide-web-starter. */
  artifacts: z
    .array(z.string().regex(/^[\w.-]+:[\w.-]+(:[\w.-]+)?$/, "group:artifact[:version]"))
    .default([]),
  annotations: z.array(FrameworkAnnotation).default([]),
  clients: z.array(FrameworkClient).default([]),
  /** A service id and the base URL it stands for: { Services.AUDIT: https://audit.tide.internal }. */
  services: z.record(QualifiedName, FrameworkValue).default({}),
  /** A constant and its value: { Topics.CARD_ISSUED: cards.issued }. */
  constants: z.record(QualifiedName, FrameworkValue).default({}),
});
export type FrameworkModel = z.infer<typeof FrameworkModel>;
