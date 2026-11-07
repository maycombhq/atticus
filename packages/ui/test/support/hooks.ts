// A tiny hooks runtime for tests: renders a function component by calling it, so a test can
// click its buttons and change its fields without a DOM (the UI tests have none).

type Slot = { v: unknown; deps?: unknown[] };
let slots: Slot[] = [];
let i = 0;
let effects: (() => void)[] = [];
let dirty = false;

const same = (a?: unknown[], b?: unknown[]) =>
  !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));

export const shim = {
  useState<T>(init: T | (() => T)) {
    const k = i++;
    if (!(k in slots)) slots[k] = { v: typeof init === "function" ? (init as () => T)() : init };
    const set = (x: T | ((o: T) => T)) => {
      const n = typeof x === "function" ? (x as (o: T) => T)(slots[k]!.v as T) : x;
      if (!Object.is(n, slots[k]!.v)) {
        slots[k]!.v = n;
        dirty = true;
      }
    };
    return [slots[k]!.v as T, set] as const;
  },
  useEffect(fn: () => void | (() => void), deps?: unknown[]) {
    const k = i++;
    const s = slots[k];
    if (!s || !same(s.deps, deps)) {
      slots[k] = { v: undefined, deps };
      effects.push(() => void fn());
    }
  },
  useMemo<T>(fn: () => T, deps: unknown[]) {
    const k = i++;
    const s = slots[k];
    if (!s || !same(s.deps, deps)) slots[k] = { v: fn(), deps };
    return slots[k]!.v as T;
  },
  useCallback<T>(fn: T, deps: unknown[]) {
    return shim.useMemo(() => fn, deps);
  },
  useRef<T>(v: T) {
    const k = i++;
    if (!(k in slots)) slots[k] = { v: { current: v } };
    return slots[k]!.v as { current: T };
  },
  useId: () => "id",
  useContext: (c: { _currentValue?: unknown }) => c._currentValue,
};

export function mount<P>(C: (p: P) => unknown, props: P) {
  slots = [];
  let tree: unknown;
  const render = () => {
    for (let n = 0; n < 20; n++) {
      i = 0;
      dirty = false;
      effects = [];
      tree = C(props);
      for (const e of effects) e();
      if (!dirty) return;
    }
  };
  render();
  return {
    get tree() {
      return tree;
    },
    render,
  };
}

type El = { type: unknown; props: Record<string, unknown> };
const isEl = (x: unknown): x is El => typeof x === "object" && x !== null && "props" in x;
export function all(t: unknown, out: El[] = []): El[] {
  if (Array.isArray(t)) for (const x of t) all(x, out);
  else if (isEl(t)) {
    out.push(t);
    all(t.props.children, out);
  }
  return out;
}
export const text = (t: unknown): string =>
  Array.isArray(t)
    ? t.map(text).join("")
    : isEl(t)
      ? text(t.props.children)
      : t == null || typeof t === "boolean"
        ? ""
        : String(t);
