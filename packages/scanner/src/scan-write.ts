import { buildAndWrite, type BuildAndWrite, type SlotWrite } from "./build.js";
import { scanEstate, type EstateScan, type ScanOptions } from "./scan.js";
import { readersSlotPath, serializeReadersSlot } from "./slots.js";

/**
 * A scan as a writer (ADR 0195 point 2: "update my slot, then build"): the readers slot of each
 * repo read in full, the build from every slot, its guards, then the write. A scan that read no
 * repo in full writes nothing (point 4). The caller holds the scan's lock. `atticus scan` says
 * more; the learning sandbox and other callers use this.
 */
export async function scanIntoCatalog(
  o: ScanOptions & { command?: string; allowRemovals?: number; discardEdits?: number },
): Promise<{ scan: EstateScan; result?: BuildAndWrite; nothingRead: boolean }> {
  const scan = await scanEstate(o);
  const nothingRead = scan.observations.length > 0 && !scan.observations.some((x) => x.full);
  if (nothingRead) return { scan, nothingRead };
  const slots: SlotWrite[] = scan.observations.flatMap((x) =>
    x.full ? [{ path: readersSlotPath(o.root, x.repo), text: serializeReadersSlot(x.slot) }] : [],
  );
  const result = await buildAndWrite(o.root, {
    command: o.command ?? "atticus scan",
    build: scan.build,
    slots,
    ...(o.allowRemovals !== undefined ? { allowRemovals: o.allowRemovals } : {}),
    ...(o.discardEdits !== undefined ? { discardEdits: o.discardEdits } : {}),
  });
  return { scan, result, nothingRead };
}
