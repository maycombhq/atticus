import { z } from "zod";

/**
 * A kept arrangement of one diagram view (ADR 0081, C6): diagrams/layouts/<view-key>.yaml in
 * the metarepo. A person dragged boxes and chose "keep this arrangement"; the view reopens with
 * these boxes where they were put, and new boxes are placed by the layout around them. People's
 * choices, not generated catalog: shared through git like any metarepo file.
 */

export const LAYOUT_SCHEMA_VERSION = 1 as const;

/** `<lens>.<node>` or `<lens>.focus.<node>`, the node's ":" written as "-": a safe file name. */
export const ViewKey = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "a view key is a lowercase slug, e.g. architecture.estate");

export const DiagramLayout = z.strictObject({
  schemaVersion: z.literal(LAYOUT_SCHEMA_VERSION),
  view: ViewKey,
  lens: z.string().min(1),
  /** The node the view opens: estate, or <kind>:<record id>. */
  node: z.string().min(1),
  /** Who kept it (the Git user) and when. */
  by: z.string().optional(),
  at: z.iso.datetime({ offset: true }).optional(),
  /** Pinned boxes: node id → top-left corner, in the canvas's units. */
  positions: z.record(z.string(), z.strictObject({ x: z.number(), y: z.number() })),
});

export type DiagramLayoutT = z.infer<typeof DiagramLayout>;

/** Where a view's arrangement lives in the metarepo. */
export const layoutPath = (view: string) => `diagrams/layouts/${view}.yaml`;
