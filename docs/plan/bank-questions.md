# Questions to settle with the bank before the pilot

Phase 0 of the revamp plan (`docs/plan/revamp.md`). Phases 7 (on-site pilot) and 8 (bank readiness) depend on the answers; asking now gives them time. Each question says why Atticus needs to know and what changes with each answer.

## 1. Models and where code may go

Atticus's scan and change stages send code excerpts, wiki text and change briefs to a language model.

1. Which model providers are approved for source code and internal documents (for example a cloud provider's hosted models in a given region, a provider's own API, or an internal gateway)?
2. Must calls go through a corporate proxy or an internal model gateway? Its address and how it authenticates (key, certificate, single sign-on).
3. Are there limits on what may be sent: whole files, excerpts only, no data from certain systems, no personal data, redaction first?
4. Is there a token or cost budget per team, and who approves raising it?
5. Is the model's output allowed to be stored in Git repositories (specs, proposals, stories) as is?

What changes: which runtime mode Atticus uses by default (a direct model, hand-off to the person's own assistant, or headless Claude Code), the proxy settings in `runtime.yaml`, and whether bulk scanning of an estate is possible or each repo is read through the person's assistant.

## 2. Assistants, extensions and MCP

Atticus hands work to the assistant a person already uses and plans an MCP server and a thin VS Code extension.

1. Which assistants are approved for developers (GitHub Copilot, Claude Code, others), and on which editors (VS Code, IntelliJ)?
2. May developers install a VS Code extension that is not from the public marketplace (installed from a signed file), or only from an internal list?
3. Is MCP allowed in Copilot or Claude Code? If so, local servers only (run on the laptop), and is there an approved list?
4. May an extension use Copilot's own model through VS Code's language model API?

What changes: whether Phase 6 ships an extension, an MCP server, both, or only the command line and copied prompts.

## 3. Open-source licences for the diagram workspace

The diagram workspace is planned on these libraries, all bundled into the app and loaded from the laptop, never from the internet:

| Library                 | Licence | Used for                                                |
| ----------------------- | ------- | ------------------------------------------------------- |
| React Flow (xyflow)     | MIT     | The interactive canvas, groups, minimap                 |
| ELK.js                  | EPL-2.0 | Layered layout with nested groups and right-angle edges |
| dagre                   | MIT     | Simpler layout, the fallback if ELK.js isn't allowed    |
| sigma.js and graphology | MIT     | Very large overviews (later)                            |

1. Are MIT and EPL-2.0 libraries allowed in an internal tool distributed to developers' laptops?
2. Is there an approved list or a request process, and how long does it take?

## 4. Installing and running Atticus

1. How does an internal developer tool reach laptops: an internal package registry (npm), a signed installer, or a software portal?
2. Is Node 22 available on developer laptops, or must Atticus ship with its own runtime?
3. Atticus runs a small web app on the laptop (localhost only). Is a local web server allowed, and on which ports?
4. What does a security review need from us (architecture, data flows, a dependency list, a penetration test), and how long does it take?

## 5. Git hosting and work items

1. Which Git host holds the code (Azure DevOps, GitHub Enterprise, another), and may a tool use a person's own token to list repos and open pull requests?
2. Which work item system holds stories and tasks, and may Atticus draft items for a person to submit?
3. Which service desk system holds change tasks and service requests (firewall rules, certificates, queues, access), and is reading its catalogue of request types allowed?

## 6. The pilot

1. Which team and a handful of repos (5 to 10) could take part, ideally one connected flow from a screen to its database?
2. Where would the pilot's metarepo live? Everything Atticus learns at the bank (repo types, answers, specs) stays in that metarepo and never leaves the bank.
3. Who would judge the output (a developer, an architect, a product owner)? They score it against a written rubric agreed before the run.
