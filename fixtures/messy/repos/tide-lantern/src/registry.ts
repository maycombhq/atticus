// Internal: not part of Lantern's API.
export function resolveService(service: string): string {
  return (globalThis as { __LANTERN_REGISTRY__?: Record<string, string> }).__LANTERN_REGISTRY__?.[service] ?? "";
}
