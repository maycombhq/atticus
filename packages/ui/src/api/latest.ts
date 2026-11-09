/**
 * Review round 46: only the newest call's answer counts. Each `start()` hands back a check that
 * stays true until a later `start()` or a `drop()`, so an answer that lands after a newer ask (or
 * after the person moved on) is left unused.
 */
export function latestCall(): { start(): () => boolean; drop(): void } {
  let n = 0;
  return {
    start() {
      const k = ++n;
      return () => k === n;
    },
    drop() {
      n++;
    },
  };
}
