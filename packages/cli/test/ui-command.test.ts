import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startUi } from "../src/ui-commands.js";

const FORGE = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/forge");

describe("atticus ui", () => {
  it("serves the built app with its session token and the API on 127.0.0.1", async () => {
    const root = await mkdtemp(join(tmpdir(), "atticus-ui-cmd-"));
    await cp(join(FORGE, "metarepo"), root, { recursive: true });
    const srv = await startUi(root, { port: 0, user: "pat", version: "1.2.3" });
    try {
      const page = await (await fetch(srv.url + "/")).text();
      expect(page).toContain(`<meta name="atticus-token" content="${srv.token}" />`);
      expect(page).toMatch(/<script type="module"[^>]+src="\.\/assets\/index-[\w-]+\.js"/);
      const h = await fetch(srv.url + "/api/health", { headers: { "X-Atticus-Token": srv.token } });
      expect(await h.json()).toMatchObject({ user: "pat", version: "1.2.3" });
      expect((await fetch(srv.url + "/api/changes", { method: "POST" })).status).toBe(401);
    } finally {
      await srv.close();
    }
  });
});
