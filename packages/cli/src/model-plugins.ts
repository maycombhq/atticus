import {
  registerModelProviderPluginLoader,
  RuntimeConfigError,
  type ModelProviderFactory,
  type ModelProviderPluginRef,
} from "@maycombhq/ai";
import { PluginProvider, type ProviderDeps, type RawSettings } from "@maycombhq/model-providers";

/**
 * Model-provider plugins (ADR 0121 item 4): a provider built from an org pack's
 * plugins/model-providers/<id>/, only when its entry file matches its pin. Its code runs in the
 * plugin sandbox and only translates; PluginProvider makes the call and adds the key.
 */
export async function pluginProviderFactory(
  p: ModelProviderPluginRef,
  deps: ProviderDeps = {},
): Promise<ModelProviderFactory> {
  // The sandbox only when a plugin is used: most commands never load it.
  const { readPinnedEntry, runTranslator } = await import("@maycombhq/sdk");
  const entry = await readPinnedEntry(p.dir, p.manifest);
  if (!entry.ok)
    throw new RuntimeConfigError(
      `The model-provider plugin org-pack/plugins/model-providers/${p.manifest.id}/ ${entry.message}.`,
    );
  const code = {
    id: p.manifest.id,
    version: p.manifest.version,
    source: entry.source,
    entry: p.manifest.entry,
    limits: p.manifest.limits,
  };
  return (settings) =>
    new PluginProvider(p.manifest, settings as RawSettings, {
      ...deps,
      translate: (fn, arg) => runTranslator(code, fn, arg),
    });
}

/** Let model mode use the org pack's plugins (the command line does this when it starts). */
export function registerModelProviderPlugins(): void {
  registerModelProviderPluginLoader((p) => pluginProviderFactory(p));
}
