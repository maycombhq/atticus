# 0091. The app in a VS Code tab: `atticus ui --embed vscode`, a link to one node, and `@atticus /diagram`

- Status: accepted (pending review by the product owner)
- Date: 2026-10-22
- Builds on: ADR 0015 (the local server), ADR 0081 (the Architecture workspace), ADR 0090 (the VS Code extension)

## Context

The extension of ADR 0090 runs the AI steps in Copilot Chat, but the diagrams (the Architecture canvas with drag, Keep and Tidy up) are only in the app, which "Open the app" starts in a terminal and shows in the browser. The product owner asked for the diagrams inside VS Code.

Drawing them a second time in the extension would mean two diagram codebases to keep alike. A VS Code webview panel can frame a page served on 127.0.0.1, so the extension can show the app itself in a tab. The server refuses that today: every response carries `X-Frame-Options: DENY`, and the app's page `frame-ancestors 'none'`, so no other page can frame it (threat model S1, clickjacking).

## Decision

1. **`atticus ui --embed vscode`** (server option `embed: "vscode"`): only the app's own files change. Their Content-Security-Policy says `frame-ancestors vscode-webview:`, and they carry no `X-Frame-Options`. Every API response keeps every header (`X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-origin` and the rest). Without the flag nothing changes. `--embed` takes only `vscode`. The session token is still handed to the app inside its page; the panel's page can't read a cross-origin frame, so it never sees the token.
2. **A link to one node:** `#/architecture?node=<id>` (with `lens=` as before) opens the canvas on that node, with its ancestors open in the outline. A node with no parts opens its parent with the node picked. A node the estate doesn't have leaves the canvas on the estate.
3. **The extension:**
   - **Atticus: Open the app** (`atticus.showApp`), and Open the app in the side view, start `atticus ui --port 0 --embed vscode --root <metarepo>` once per window. The extension reads the address it prints and frames the app in a tab. The tab's own page has a Content-Security-Policy of `default-src 'none'; frame-src http://127.0.0.1:*` and runs no script. The app stops when the window closes.
   - **`@atticus /diagram [repo]`** and **Atticus: Open a repo on the Architecture canvas** open that link. A repo name becomes `repo:<slug>` the way the estate names it; a node id (`system:payments`) is taken as it is; nothing named opens the estate.
   - **Atticus: Open the app in the browser** keeps the old behaviour.
4. **No contract changes.** No record, org-pack, plugin SDK or AI runtime schema changes. The local API is unchanged; `--embed` is a new command option.

## Consequences

- Inside VS Code, a person sees and rearranges the same diagrams, and every other screen, in a tab beside the code. There is one app.
- Any VS Code webview on the machine could frame the app once it is started for the panel, which includes webviews from other extensions. They already run code on the same machine with the person's rights, so framing gives them nothing they lack. The browser and every other site still can't frame the app.
- Not proven yet: that a VS Code webview at the bank frames a 127.0.0.1 page (it is supposed to; a locked-down setup may block it), and that it works in remote setups (SSH, containers), where the address goes through `asExternalUri`. When framing is blocked, Open the app in the browser still works.
- Spec flows (the step-by-step flows of `atticus spec`) still have no diagram in the app; the canvas draws the estate's systems, repos, components, endpoints and tables.
