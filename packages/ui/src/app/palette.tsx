import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client.js";
import { groupLabel, sectionLabel, SCREENS } from "./screens.js";
import { COPY } from "../copy.js";

const T = COPY.palette;

/** The event that opens Ctrl+K without the keys: the menu's hint (an editor's panel may take them). */
export const OPEN_PALETTE = "atticus:open-palette";

interface Item {
  kind: "screen" | "change" | "record" | "ask";
  label: string;
  detail: string;
  href: string;
}

/**
 * Pure: the palette's items for what was typed, screens first. Every page, More pages' too, with
 * or without `atticus ui --full` (2026-10-25: anything that exists is findable). Exported for tests.
 */
export function paletteItems(
  text: string,
  changes: { id: string; title: string; state: string }[],
  records: { kind: string; id: string; name?: string }[],
): Item[] {
  const t = text.trim().toLowerCase();
  const hit = (s: string) => !t || s.toLowerCase().includes(t);
  const out: Item[] = [
    ...SCREENS.filter((s) => hit(s.label) || hit(s.id) || (s.also ?? []).some(hit)).map((s) => ({
      kind: "screen" as const,
      label: s.label,
      detail: s.group
        ? `${sectionLabel(s.section)} · ${groupLabel(s.group)}`
        : sectionLabel(s.section),
      href: `#/${s.id}`,
    })),
    ...changes
      .filter((c) => hit(c.id) || hit(c.title))
      .map((c) => ({
        kind: "change" as const,
        label: c.title,
        detail: `${c.id} · ${c.state}`,
        href: `#/changes/${encodeURIComponent(c.id)}`,
      })),
    ...records.map((r) => ({
      kind: "record" as const,
      label: r.name && r.name !== r.id ? `${r.id} · ${r.name}` : r.id,
      detail: r.kind,
      href:
        r.kind === "Capability"
          ? `#/features?id=${encodeURIComponent(r.id)}`
          : `#/explore?q=${encodeURIComponent(r.id)}`,
    })),
  ];
  if (t)
    out.push({
      kind: "ask",
      label: T.askItem(text.trim()),
      detail: T.askDetail,
      href: `#/explore?ask=${encodeURIComponent(text.trim())}`,
    });
  return out.slice(0, 14);
}

/** Ctrl+K (Cmd+K): jump to any screen, change or catalog record, or ask a question. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  const [changes, setChanges] = useState<{ id: string; title: string; state: string }[]>([]);
  const [records, setRecords] = useState<{ kind: string; id: string; name?: string }[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const back = useRef<Element | null>(null);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        back.current = document.activeElement;
        setOpen((o) => !o);
      }
    };
    const ask = () => {
      back.current = document.activeElement;
      setOpen(true);
    };
    addEventListener("keydown", on);
    addEventListener(OPEN_PALETTE, ask);
    return () => {
      removeEventListener("keydown", on);
      removeEventListener(OPEN_PALETTE, ask);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setText("");
    setSel(0);
    input.current?.focus();
    void api<{ id: string; title: string; state: string }[]>("/api/changes")
      .then(setChanges)
      .catch(() => setChanges([]));
  }, [open]);

  useEffect(() => {
    const t = text.trim();
    if (!open || t.length < 2) {
      setRecords([]);
      return;
    }
    const timer = setTimeout(() => {
      void api<{ rows: { kind: string; id: string; name?: string }[] }>(
        `/api/search?q=${encodeURIComponent(t.split(/\s+/)[0]!)}&limit=6`,
      )
        .then((r) => setRecords(r.rows))
        .catch(() => setRecords([]));
    }, 150);
    return () => clearTimeout(timer);
  }, [text, open]);

  const items = useMemo(() => paletteItems(text, changes, records), [text, changes, records]);
  const close = () => {
    setOpen(false);
    (back.current as HTMLElement | null)?.focus?.();
  };
  const go = (i: Item | undefined) => {
    if (!i) return;
    location.hash = i.href;
    close();
  };
  if (!open) return null;
  return (
    <div className="palette-backdrop" onClick={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={T.goToAnything}
        className="palette panel"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          else if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((s) => Math.min(s + 1, items.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((s) => Math.max(s - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            go(items[sel]);
          }
        }}
      >
        <label htmlFor="palette-input" className="sr">
          {T.goToAScreen}
        </label>
        <input
          id="palette-input"
          ref={input}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSel(0);
          }}
          placeholder={T.goToAScreen2}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={items[sel] ? `palette-${sel}` : undefined}
          autoComplete="off"
        />
        <ul id="palette-list" role="listbox" aria-label={T.results}>
          {items.map((i, k) => (
            <li
              key={`${i.kind}/${i.href}`}
              id={`palette-${k}`}
              role="option"
              aria-selected={k === sel}
              onMouseEnter={() => setSel(k)}
              onClick={() => go(i)}
            >
              <span>{i.label}</span>
              <span className="hud" style={{ fontSize: 9.5 }}>
                {i.kind} · {i.detail}
              </span>
            </li>
          ))}
          {items.length === 0 && <li className="muted">{T.nothingMatches}</li>}
        </ul>
        <div className="hud" style={{ fontSize: 9.5, marginTop: 8 }}>
          {T.toMoveEnterTo}
        </div>
      </div>
    </div>
  );
}
