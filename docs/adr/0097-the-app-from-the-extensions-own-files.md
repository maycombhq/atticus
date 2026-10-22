# 0097. The app in a VS Code panel from the extension's own files

- Status: accepted (pending review by the product owner)
- Date: 2026-10-22
- Builds on: ADR 0091 (the app in a VS Code tab), ADR 0015 (the local server), ADR 0093 (the extension reads the local API)

## Context

ADR 0091 put the app in a VS Code tab by framing the page `atticus ui` serves on 127.0.0.1. That needs two things the bank's VS Code may not allow: a webview framing a local page, and, over SSH or in a container, the editor reaching that address. If either is blocked, the diagrams can't be shown inside the editor.

## Decision

1. **The extension ships the app's build.** `packages/vscode/scripts/copy-app.mjs` copies `packages/ui/dist` into `media/app/` when the extension is packaged, without source maps. The `.vsix` is 1.73 MB.
2. **The panel loads it directly.** The extension reads `media/app/index.html` and gives it to the webview:
   - a `<base>` at the webview's URI for `media/app/`;
   - a Content-Security-Policy of `default-src 'none'`, scripts with a nonce and from the extension's files only, `connect-src` to the extension's files only, `worker-src blob:`;
   - a nonce on every script;
   - the session-token meta removed;
   - a first script that sets the view to open (`#/<screen>…`; anything else opens the dashboard).

   `localResourceRoots` is `media/app` only.

3. **The bridge.**
   - **Calls:** in a panel the app finds `acquireVsCodeApi` and sends each API call as a message (`{ type: "api", id, method, path, body }`). The extension checks it: only GET, POST, PUT, PATCH and DELETE, and only paths under `/api/` without `..`. It then calls the local API with the session token, which never reaches the page, and answers with the status and body as they came (`api-reply`). When the local API doesn't answer, the reply is a 503 that says so.
   - **Events and navigation:** live events (a file under `specs/`, `catalog/`, `openspec/` or `questions/` changed) and "go to this view" (`navigate`, checked against the app's own screen pattern) come as messages too. An open panel moves to the new view without reloading, so an arrangement the person made stays.
   - **The worker:** the layout worker's script is on the files' origin, not the page's. The app fetches it and starts the worker from a same-origin copy (a `blob:` URL), which the CSP allows.
4. **The framed page stays as a fallback.** The setting `atticus.appIn` defaults to `panel`. `frame` uses ADR 0091's framed page, and so does a build of the extension without `media/app`.
5. **No contract changes.** The local API is unchanged. The bridge is the extension's and the app's own protocol, inside one machine.

## Consequences

- Inside VS Code, the diagrams and every other screen of the app no longer depend on framing a local page, or on the editor reaching 127.0.0.1 from the webview. The extension still starts `atticus ui` and calls it from the extension host, which runs where the metarepo is (over SSH, that is the remote machine).
- Checked in Chromium with a harness that mirrors a webview:
  - the page and the files on different origins, under the same CSP;
  - the extension's own `bundledHtml` and `answerApp`, against nadi-meta's local API.

  "Save a chart" opened with step 8 marked, a navigate message switched to the Architecture canvas, the canvas laid out 20 boxes through the worker copy, there were no errors, and axe reported nothing serious. It has not yet run inside a real VS Code webview.

- The app in the extension is the build that was current when the extension was packaged. A newer `atticus` with a different app needs the extension packaged again; the local API's version tells them apart.
