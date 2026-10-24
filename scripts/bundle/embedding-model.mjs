// The local embedding model in the offline bundle (ADR 0116): the model folder as the package
// @maycombhq/embed-model (so `retrieval.embeddings.model: bundled` finds it), and the ONNX
// runtime for one platform: onnxruntime-node's CPU build without the DirectML files (their licence
// isn't on the allowed list) and onnxruntime-web's WASM build as the fallback. Copied from folders
// a person gives; nothing is downloaded, and the model's sha256 is checked against its manifest.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Files never shipped, whatever folder they come from: DirectML and its shader compiler. */
export const FORBIDDEN = /^(DirectML|dxcompiler|dxil)\.dll$/i;

const manifestField = (text, key) =>
  new RegExp(`^${key}:\\s*"?([^"\\n]*)"?\\s*$`, "m").exec(text)?.[1];

export function addEmbeddingModel(dir, o) {
  if (!o.model && !o.ort) return undefined;
  if (!o.model || !o.ort) {
    console.error(
      "ATTICUS_BUNDLE_MODEL and ATTICUS_BUNDLE_ORT go together: the model and its runtime.",
    );
    process.exit(1);
  }
  const yaml = readFileSync(join(o.model, "atticus-model.yaml"), "utf8");
  const name = manifestField(yaml, "name");
  const sha = manifestField(yaml, "sha256");
  const licence = manifestField(yaml, "licence");
  const file = manifestField(yaml, "model") ?? "model.onnx";
  if (manifestField(yaml, "dtype") !== "fp32") {
    console.error(`${o.model}: only an fp32 model ships (atticus-model.yaml dtype).`);
    process.exit(1);
  }
  const got = createHash("sha256")
    .update(readFileSync(join(o.model, file)))
    .digest("hex");
  if (got !== sha) {
    console.error(`${join(o.model, file)} has sha256 ${got}, not the ${sha} its manifest names.`);
    process.exit(1);
  }
  const licenceFile = ["LICENSE", "LICENSE.txt", "LICENCE"].find((f) =>
    existsSync(join(o.model, f)),
  );
  if (!licenceFile) {
    console.error(`${o.model}: no LICENSE file; the model ships only with its licence text.`);
    process.exit(1);
  }
  const pkg = join(dir, "node_modules", "@maycombhq", "embed-model");
  mkdirSync(pkg, { recursive: true });
  for (const f of readdirSync(o.model)) cpSync(join(o.model, f), join(pkg, f), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    `${JSON.stringify(
      {
        name: "@maycombhq/embed-model",
        version: `1.0.0-${sha.slice(0, 12)}`,
        description: `The local embedding model ${name} for Atticus (ADR 0116): fp32 ONNX, run on this machine.`,
        license: licence,
        atticusModel: { name, sha256: sha, source: manifestField(yaml, "source") },
      },
      null,
      2,
    )}\n`,
  );
  // The runtime, for this platform only.
  const [platform, arch] = o.platform.split("-");
  const nm = join(o.ort, "node_modules");
  const node = join(nm, "onnxruntime-node");
  const out = join(dir, "node_modules", "onnxruntime-node");
  mkdirSync(out, { recursive: true });
  for (const f of ["package.json", "README.md", "LICENSE", "dist"])
    if (existsSync(join(node, f))) cpSync(join(node, f), join(out, f), { recursive: true });
  const bin = join(node, "bin", "napi-v6", platform, arch);
  if (!existsSync(bin)) {
    console.error(`onnxruntime-node has no CPU build for ${o.platform} in ${bin}.`);
    process.exit(1);
  }
  const binOut = join(out, "bin", "napi-v6", platform, arch);
  mkdirSync(binOut, { recursive: true });
  for (const f of readdirSync(bin)) if (!FORBIDDEN.test(f)) cpSync(join(bin, f), join(binOut, f));
  // Its package.json names its install script's helpers (a downloader): not needed to run, not shipped.
  const pj = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
  pj.dependencies = { "onnxruntime-common": pj.dependencies?.["onnxruntime-common"] };
  delete pj.scripts;
  writeFileSync(join(out, "package.json"), `${JSON.stringify(pj, null, 2)}\n`);
  cpSync(join(nm, "onnxruntime-common"), join(dir, "node_modules", "onnxruntime-common"), {
    recursive: true,
  });
  const web = join(nm, "onnxruntime-web");
  if (existsSync(web)) {
    const wout = join(dir, "node_modules", "onnxruntime-web");
    mkdirSync(join(wout, "dist"), { recursive: true });
    for (const f of ["package.json", "README.md", "LICENSE"])
      if (existsSync(join(web, f))) cpSync(join(web, f), join(wout, f));
    // ort.node.min.js only so the package resolves; Atticus imports the WASM build by path.
    for (const f of [
      "ort.node.min.js",
      "ort.wasm.min.mjs",
      "ort-wasm-simd-threaded.mjs",
      "ort-wasm-simd-threaded.wasm",
    ])
      cpSync(join(web, "dist", f), join(wout, "dist", f));
    const wj = JSON.parse(readFileSync(join(wout, "package.json"), "utf8"));
    wj.dependencies = { "onnxruntime-common": wj.dependencies?.["onnxruntime-common"] };
    delete wj.scripts;
    writeFileSync(join(wout, "package.json"), `${JSON.stringify(wj, null, 2)}\n`);
  }
  return `Added the embedding model ${name} (${licence}, sha256 ${sha.slice(0, 12)}) and onnxruntime for ${o.platform}.`;
}
