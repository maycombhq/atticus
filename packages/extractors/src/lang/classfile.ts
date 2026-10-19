/**
 * A small, defensive reader of compiled Java classes (the class file format of the JVM spec),
 * for learning what a house framework means when only its JAR is at hand (ADR 0054). It reads
 * what a framework model needs, and only that: the class's name, kind and supertypes, its
 * annotations (runtime-visible and class-retention) with their values, static final constants,
 * and methods with their parameter names (from MethodParameters, else the debug
 * LocalVariableTable) and annotations. Nothing is run or decompiled. Bytes come from JARs on
 * people's machines, so every read is bounds-checked and a malformed file throws.
 */

export class ClassFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassFileError";
  }
}

/** An annotation value: a constant as text, an enum as Type.CONST, a class as its simple name, a list. */
export type ElementValue = string | ElementValue[] | ClassAnnotation;

export interface ClassAnnotation {
  /** Simple name: RequestMapping. */
  name: string;
  /** Qualified name: org.springframework.web.bind.annotation.RequestMapping. */
  qualified: string;
  values: Record<string, ElementValue>;
}

export interface ClassMethod {
  name: string;
  isPublic: boolean;
  isStatic: boolean;
  /** Parameter names when the class keeps them, else arg0, arg1... */
  params: string[];
  annotations: ClassAnnotation[];
}

export interface ClassInfo {
  /** Qualified name: tide.platform.web.InternalApi (nested: Outer$Inner). */
  name: string;
  simpleName: string;
  packageName: string;
  isAnnotation: boolean;
  isPublic: boolean;
  annotations: ClassAnnotation[];
  fields: { name: string; isStatic: boolean; isFinal: boolean; constant?: string }[];
  methods: ClassMethod[];
  /** Every class the constant pool names, qualified: what the class uses. */
  references: string[];
}

const ACC_PUBLIC = 0x0001;
const ACC_STATIC = 0x0008;
const ACC_FINAL = 0x0010;
const ACC_SYNTHETIC = 0x1000;
const ACC_BRIDGE = 0x0040;
const ACC_ANNOTATION = 0x2000;

type Const =
  | { t: "utf8"; v: string }
  | { t: "class"; name: number }
  | { t: "string"; v: number }
  | { t: "num"; v: string }
  | { t: "other" };

const dotted = (internal: string) => internal.replace(/\//g, ".");
const simple = (qualified: string) => qualified.slice(qualified.lastIndexOf(".") + 1);
/** "Lorg/x/Y;" → "org.x.Y" */
const fromDescriptor = (d: string) => dotted(d.replace(/^L/, "").replace(/;$/, ""));

export function parseClass(bytes: Uint8Array): ClassInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const need = (n: number) => {
    if (p + n > bytes.length) throw new ClassFileError("the class file ends early");
  };
  const u1 = () => (need(1), view.getUint8(p++));
  const u2 = () => {
    need(2);
    const v = view.getUint16(p);
    p += 2;
    return v;
  };
  const u4 = () => {
    need(4);
    const v = view.getUint32(p);
    p += 4;
    return v;
  };
  const skip = (n: number) => {
    need(n);
    p += n;
  };

  if (u4() !== 0xcafebabe) throw new ClassFileError("not a class file");
  skip(4); // minor, major
  const count = u2();
  const pool: Const[] = [{ t: "other" }];
  for (let i = 1; i < count; i++) {
    const tag = u1();
    switch (tag) {
      case 1: {
        const len = u2();
        need(len);
        pool.push({ t: "utf8", v: new TextDecoder().decode(bytes.subarray(p, p + len)) });
        p += len;
        break;
      }
      case 3:
        pool.push({ t: "num", v: String(view.getInt32((need(4), p))) });
        p += 4;
        break;
      case 4:
        skip(4);
        pool.push({ t: "other" });
        break;
      case 5:
      case 6:
        skip(8);
        pool.push({ t: "other" }, { t: "other" }); // longs and doubles take two slots
        i++;
        break;
      case 7:
        pool.push({ t: "class", name: u2() });
        break;
      case 8:
        pool.push({ t: "string", v: u2() });
        break;
      case 9:
      case 10:
      case 11:
      case 12:
      case 17:
      case 18:
        skip(4);
        pool.push({ t: "other" });
        break;
      case 15:
        skip(3);
        pool.push({ t: "other" });
        break;
      case 16:
      case 19:
      case 20:
        skip(2);
        pool.push({ t: "other" });
        break;
      default:
        throw new ClassFileError(`unknown constant pool tag ${tag}`);
    }
  }
  const utf8 = (i: number): string => {
    const c = pool[i];
    if (c?.t !== "utf8") throw new ClassFileError(`constant ${i} is not text`);
    return c.v;
  };
  const className = (i: number): string => {
    const c = pool[i];
    if (c?.t !== "class") throw new ClassFileError(`constant ${i} is not a class`);
    return dotted(utf8(c.name));
  };
  const constText = (i: number): string => {
    const c = pool[i];
    if (c?.t === "utf8") return c.v;
    if (c?.t === "string") return utf8(c.v);
    if (c?.t === "num") return c.v;
    return "";
  };

  const elementValue = (): ElementValue => {
    const tag = String.fromCharCode(u1());
    if ("BCDFIJSZ".includes(tag)) return constText(u2());
    if (tag === "s") return utf8(u2());
    if (tag === "e") {
      const type = simple(fromDescriptor(utf8(u2())));
      return `${type}.${utf8(u2())}`;
    }
    if (tag === "c") return simple(fromDescriptor(utf8(u2())));
    if (tag === "@") return annotation();
    if (tag === "[") {
      const n = u2();
      const out: ElementValue[] = [];
      for (let i = 0; i < n; i++) out.push(elementValue());
      return out;
    }
    throw new ClassFileError(`unknown annotation value tag ${tag}`);
  };
  const annotation = (): ClassAnnotation => {
    const qualified = fromDescriptor(utf8(u2()));
    const values: Record<string, ElementValue> = {};
    const n = u2();
    for (let i = 0; i < n; i++) values[utf8(u2())] = elementValue();
    return { name: simple(qualified), qualified, values };
  };
  const annotations = (): ClassAnnotation[] => {
    const n = u2();
    const out: ClassAnnotation[] = [];
    for (let i = 0; i < n; i++) out.push(annotation());
    return out;
  };

  const access = u2();
  const name = className(u2());
  u2(); // super_class (0 for java.lang.Object)
  skip(u2() * 2); // interfaces
  const fields: ClassInfo["fields"] = [];
  for (let n = u2(), i = 0; i < n; i++) {
    const fa = u2();
    const fname = utf8(u2());
    u2(); // descriptor
    let constant: string | undefined;
    for (let m = u2(), j = 0; j < m; j++) {
      const an = utf8(u2());
      const len = u4();
      const end = p + len;
      if (an === "ConstantValue") constant = constText(u2());
      p = end;
      need(0);
    }
    fields.push({
      name: fname,
      isStatic: (fa & ACC_STATIC) !== 0,
      isFinal: (fa & ACC_FINAL) !== 0,
      ...(constant !== undefined ? { constant } : {}),
    });
  }
  const methods: ClassMethod[] = [];
  for (let n = u2(), i = 0; i < n; i++) {
    const ma = u2();
    const mname = utf8(u2());
    const desc = utf8(u2());
    const slots = paramSlots(desc);
    let byParams: string[] | undefined;
    const bySlot = new Map<number, string>();
    const anns: ClassAnnotation[] = [];
    for (let m = u2(), j = 0; j < m; j++) {
      const an = utf8(u2());
      const len = u4();
      const end = p + len;
      if (an === "MethodParameters") {
        byParams = [];
        for (let k = u1(), x = 0; x < k; x++) {
          const ni = u2();
          u2();
          byParams.push(ni ? utf8(ni) : `arg${x}`);
        }
      } else if (an === "RuntimeVisibleAnnotations" || an === "RuntimeInvisibleAnnotations") {
        anns.push(...annotations());
      } else if (an === "Code") {
        skip(4); // max_stack, max_locals
        skip(u4()); // code
        skip(u2() * 8); // exception table
        for (let k = u2(), x = 0; x < k; x++) {
          const can = utf8(u2());
          const clen = u4();
          const cend = p + clen;
          if (can === "LocalVariableTable")
            for (let v = u2(), y = 0; y < v; y++) {
              skip(4); // start_pc, length
              const vn = utf8(u2());
              u2(); // descriptor
              bySlot.set(u2(), vn);
            }
          p = cend;
          need(0);
        }
      }
      p = end;
      need(0);
    }
    if ((ma & (ACC_SYNTHETIC | ACC_BRIDGE)) !== 0) continue;
    const first = (ma & ACC_STATIC) !== 0 ? 0 : 1;
    const params = byParams ?? slots.map((s, k) => bySlot.get(s + first) ?? `arg${k}`);
    methods.push({
      name: mname,
      isPublic: (ma & ACC_PUBLIC) !== 0,
      isStatic: (ma & ACC_STATIC) !== 0,
      params,
      annotations: anns,
    });
  }
  const classAnns: ClassAnnotation[] = [];
  for (let n = u2(), i = 0; i < n; i++) {
    const an = utf8(u2());
    const len = u4();
    const end = p + len;
    if (an === "RuntimeVisibleAnnotations" || an === "RuntimeInvisibleAnnotations")
      classAnns.push(...annotations());
    p = end;
    need(0);
  }
  const references = [
    ...new Set(
      pool.flatMap((c) => (c.t === "class" ? [dotted(utf8(c.name)).replace(/^\[+L|;$/g, "")] : [])),
    ),
  ].sort();
  const dot = name.lastIndexOf(".");
  return {
    name,
    simpleName: name.slice(dot + 1).replace(/^.*\$/, ""),
    packageName: dot > 0 ? name.slice(0, dot) : "",
    isAnnotation: (access & ACC_ANNOTATION) !== 0,
    isPublic: (access & ACC_PUBLIC) !== 0,
    annotations: classAnns,
    fields,
    methods,
    references,
  };
}

/** The local-variable slot of each parameter in a method descriptor (long and double take two). */
function paramSlots(desc: string): number[] {
  const m = /^\(([^)]*)\)/.exec(desc);
  if (!m) throw new ClassFileError(`not a method descriptor: ${desc}`);
  const out: number[] = [];
  let slot = 0;
  const s = m[1]!;
  for (let i = 0; i < s.length;) {
    out.push(slot);
    let c = s[i]!;
    while (c === "[") c = s[++i]!;
    const array = i > 0 && s[i - 1] === "[" && out.length > 0;
    if (c === "L") i = s.indexOf(";", i) + 1;
    else i++;
    slot += !array && (c === "J" || c === "D") ? 2 : 1;
  }
  return out;
}
