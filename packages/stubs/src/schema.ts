/**
 * The JSON Schema subset a stub understands, shared by OpenAPI 3.0, 3.1 and Swagger 2.0:
 * type (with nullable and type lists), required, enum, const, properties, items, allOf,
 * oneOf/anyOf, basic formats and ranges. Anything else is accepted rather than guessed at,
 * because a stub that rejects valid requests is worse than one that lets odd ones through.
 */
export interface JsonSchema {
  type?: string | string[];
  nullable?: boolean;
  format?: string;
  enum?: unknown[];
  const?: unknown;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  allOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  readOnly?: boolean;
  writeOnly?: boolean;
  example?: unknown;
  examples?: unknown;
  default?: unknown;
}

export interface SchemaError {
  /** JSON Pointer to the value, "" for the root. */
  pointer: string;
  message: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isSchema = (s: JsonSchema | undefined): s is JsonSchema =>
  typeof s === "object" && s !== null && !Array.isArray(s);

const types = (s: JsonSchema): string[] => {
  const t = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
  return s.nullable && t.length > 0 && !t.includes("null") ? [...t, "null"] : t;
};

const FORMATS: Record<string, { test: (s: string) => boolean; message: string }> = {
  date: {
    test: (s) => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s),
    message: "must be a date (YYYY-MM-DD)",
  },
  "date-time": {
    test: (s) =>
      /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(s) &&
      !Number.isNaN(Date.parse(s)),
    message: "must be a date-time (RFC 3339)",
  },
  uuid: {
    test: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
    message: "must be a UUID",
  },
  email: { test: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s), message: "must be an email address" },
  uri: { test: (s) => /^[a-z][a-z0-9+.-]*:\S*$/i.test(s), message: "must be a URI" },
  ipv4: {
    test: (s) => /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/.test(s),
    message: "must be an IPv4 address",
  },
};

const TYPE_MESSAGE: Record<string, string> = {
  string: "must be a string",
  integer: "must be an integer",
  number: "must be a number",
  boolean: "must be true or false",
  object: "must be an object",
  array: "must be an array",
  null: "must be null",
};

function hasType(v: unknown, t: string): boolean {
  switch (t) {
    case "string":
      return typeof v === "string";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "object":
      return isObj(v);
    case "array":
      return Array.isArray(v);
    case "null":
      return v === null;
    default:
      return true;
  }
}

const pointerPart = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");
const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * Check a value against a schema. `direction` request skips readOnly properties (a client
 * doesn't send them); response skips writeOnly ones. Errors come in schema order.
 */
export function validate(
  value: unknown,
  schema: JsonSchema | undefined,
  pointer = "",
  direction: "request" | "response" = "request",
): SchemaError[] {
  if (!isSchema(schema)) return [];
  const errors: SchemaError[] = [];
  const err = (message: string, p = pointer) => errors.push({ pointer: p, message });

  for (const sub of schema.allOf ?? []) errors.push(...validate(value, sub, pointer, direction));
  const alts = schema.oneOf ?? schema.anyOf;
  if (
    alts &&
    alts.length > 0 &&
    !alts.some((a) => validate(value, a, pointer, direction).length === 0)
  )
    err("doesn't match any of the allowed shapes");

  const t = types(schema);
  if (t.length > 0 && !t.some((x) => hasType(value, x))) {
    // An integer is also a number; report the narrowest expectation.
    err(TYPE_MESSAGE[t.find((x) => x !== "null") ?? "null"] ?? `must be ${t.join(" or ")}`);
    return errors;
  }
  if (value === null) return errors;
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value))
    err(`must be ${show(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value)))
    err(`must be one of ${schema.enum.map(show).join(", ")}`);

  if (typeof value === "string") {
    const f = schema.format ? FORMATS[schema.format] : undefined;
    if (f && !f.test(value)) err(f.message);
    if (schema.minLength !== undefined && value.length < schema.minLength)
      err(
        `must be at least ${schema.minLength} character${schema.minLength === 1 ? "" : "s"} long`,
      );
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      err(`must be at most ${schema.maxLength} character${schema.maxLength === 1 ? "" : "s"} long`);
  }
  if (typeof value === "number") {
    if (schema.format === "int32" && (value < -2147483648 || value > 2147483647))
      err("must fit in 32 bits");
    const exMin =
      typeof schema.exclusiveMinimum === "number"
        ? schema.exclusiveMinimum
        : schema.exclusiveMinimum === true
          ? schema.minimum
          : undefined;
    const exMax =
      typeof schema.exclusiveMaximum === "number"
        ? schema.exclusiveMaximum
        : schema.exclusiveMaximum === true
          ? schema.maximum
          : undefined;
    if (exMin !== undefined && value <= exMin) err(`must be more than ${exMin}`);
    else if (schema.minimum !== undefined && value < schema.minimum)
      err(`must be at least ${schema.minimum}`);
    if (exMax !== undefined && value >= exMax) err(`must be less than ${exMax}`);
    else if (schema.maximum !== undefined && value > schema.maximum)
      err(`must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      err(`must have at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}`);
    if (schema.items)
      value.forEach((v, i) =>
        errors.push(...validate(v, schema.items, `${pointer}/${i}`, direction)),
      );
  }
  if (isObj(value)) {
    const props = schema.properties ?? {};
    const skip = (k: string) =>
      direction === "request" ? props[k]?.readOnly === true : props[k]?.writeOnly === true;
    for (const k of schema.required ?? [])
      if (value[k] === undefined && !skip(k)) err("is required", `${pointer}/${pointerPart(k)}`);
    for (const [k, sub] of Object.entries(props))
      if (value[k] !== undefined)
        errors.push(...validate(value[k], sub, `${pointer}/${pointerPart(k)}`, direction));
  }
  return errors;
}

/** Turn a parameter's text into the type its schema asks for, or leave it as text. */
export function coerce(text: string, schema: JsonSchema | undefined): unknown {
  const t = schema ? types(schema) : [];
  if (t.includes("string") || t.length === 0) return text;
  if (
    (t.includes("integer") || t.includes("number")) &&
    /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)
  )
    return Number(text);
  if (t.includes("boolean") && (text === "true" || text === "false")) return text === "true";
  if (t.includes("null") && text === "null") return null;
  return text;
}

/** Fixed sample values: generated bodies must not depend on the clock or randomness. */
const FORMAT_SAMPLES: Record<string, string> = {
  date: "2024-01-01",
  "date-time": "2024-01-01T00:00:00Z",
  uuid: "00000000-0000-4000-8000-000000000000",
  email: "user@example.com",
  uri: "https://example.com/",
  ipv4: "192.0.2.1",
  byte: "AA==",
};

/** The schema's own example: example, then the first of examples (3.1), then default. */
export function schemaExample(
  schema: JsonSchema | undefined,
): { value: unknown; source: "schema-example" | "schema-default" } | undefined {
  if (!isSchema(schema)) return undefined;
  if (schema.example !== undefined) return { value: schema.example, source: "schema-example" };
  if (Array.isArray(schema.examples) && schema.examples.length > 0)
    return { value: schema.examples[0], source: "schema-example" };
  if (schema.default !== undefined) return { value: schema.default, source: "schema-default" };
  return undefined;
}

/**
 * A value that fits the schema, built the same way every time: examples and defaults
 * first, then the first enum value, the first alternative, every property, one array item.
 */
export function generate(schema: JsonSchema | undefined, depth = 0): unknown {
  if (!isSchema(schema) || depth > 12) return null;
  const own = schemaExample(schema);
  if (own) return own.value;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  if (schema.allOf && schema.allOf.length > 0) {
    const parts = schema.allOf.map((s) => generate(s, depth + 1));
    const mine = schema.properties ? generate({ ...schema, allOf: undefined }, depth + 1) : {};
    if (parts.every(isObj) && isObj(mine)) return Object.assign({}, ...parts, mine) as unknown;
    return parts[0];
  }
  const alts = schema.oneOf ?? schema.anyOf;
  if (alts && alts.length > 0) return generate(alts[0], depth + 1);
  const t =
    types(schema).find((x) => x !== "null") ??
    (schema.properties ? "object" : schema.items ? "array" : undefined);
  switch (t) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(schema.properties ?? {}))
        if (!sub.writeOnly) out[k] = generate(sub, depth + 1);
      return out;
    }
    case "array": {
      const n = Math.max(1, schema.minItems ?? 1);
      return Array.from({ length: n }, () => generate(schema.items, depth + 1));
    }
    case "string": {
      const s = (schema.format && FORMAT_SAMPLES[schema.format]) ?? "string";
      return schema.minLength && s.length < schema.minLength ? s.padEnd(schema.minLength, "x") : s;
    }
    case "integer":
    case "number": {
      let n =
        schema.minimum ??
        (typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum : 0);
      if (schema.minimum === undefined && schema.maximum !== undefined && schema.maximum < n)
        n = schema.maximum;
      if (schema.exclusiveMinimum === true || typeof schema.exclusiveMinimum === "number") n += 1;
      return t === "integer" ? Math.ceil(n) : n;
    }
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return {};
  }
}
