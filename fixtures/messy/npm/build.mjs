// Builds tide-lantern-4.1.0.tgz the way `npm pack` lays it out (every file under package/),
// from the fixture's package.json and dist/: what a team has when it has only the published
// package, not Lantern's source. Run from the repo root: node fixtures/messy/npm/build.mjs
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "../repos/tide-lantern");

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** One ustar header and the file's bytes, padded to 512. */
function entry(name, data) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write("0", 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad]);
}

const files = ["package.json", ...walk(join(SRC, "dist")).map((p) => relative(SRC, p))]
  .map((p) => p.split("\\").join("/"))
  .sort();
const tar = Buffer.concat([
  ...files.map((f) => entry(`package/${f}`, readFileSync(join(SRC, f)))),
  Buffer.alloc(1024),
]);
writeFileSync(join(HERE, "tide-lantern-4.1.0.tgz"), gzipSync(tar, { level: 9 }));
console.log(`Wrote tide-lantern-4.1.0.tgz (${files.length} files)`);
