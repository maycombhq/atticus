import { useState } from "react";
import type { Api } from "@maycombhq/core";
import { api } from "../../api/client.js";
import { COPY } from "../../copy.js";

/**
 * G6 (ADR 0175): a cited line, opened in the person's editor: the file in the repo's checkout, as
 * a VS Code or IntelliJ link. Asked for when clicked, so a page of citations reads nothing first.
 */
export function OpenCode({ repo, at }: { repo: string; at: string }) {
  const [link, setLink] = useState<Api.CodeLinkT | undefined>();
  const [failed, setFailed] = useState<string | undefined>();
  if (link?.missing) return <span className="hud"> · {link.missing}</span>;
  if (link)
    return (
      <span className="row" style={{ gap: 6, display: "inline-flex" }}>
        {link.vscode && (
          <a className="hud" href={link.vscode}>
            {COPY.canvasTools.inVsCode}
          </a>
        )}
        {link.idea && (
          <a className="hud" href={link.idea}>
            {COPY.canvasTools.inIntellij}
          </a>
        )}
      </span>
    );
  return (
    <>
      <button
        type="button"
        className="link hud"
        onClick={() =>
          void api<Api.CodeLinkT>(
            `/api/code-link?repo=${encodeURIComponent(repo)}&at=${encodeURIComponent(at)}`,
          ).then(setLink, (e: unknown) => setFailed(e instanceof Error ? e.message : String(e)))
        }
      >
        {COPY.canvasTools.openCode}
      </button>
      {failed && <span className="hud"> · {failed}</span>}
    </>
  );
}
