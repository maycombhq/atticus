# What Atticus is

Atticus is an open-source framework for teams whose systems span many repositories, gateways, event streams and vendors. It is a command line (`atticus`) and a local app (`atticus ui`) on each person's own machine, working on a Git repository the team shares. There is no server to run.

The rule behind it: your AI assistant does the thinking; Atticus keeps the files, checks them in deterministic code, and names the next step. Its own tests never call a model.

## The metarepo

The team's shared Git repository. It holds the list of your repos, the catalog Atticus builds from them, every change in flight, the questions waiting for a person, and the org pack: your organisation's configuration and rules. Everything in it changes through pull requests. `atticus init` makes one; `atticus adopt` uses Atticus inside a single repo instead.

## Facts, and the verifier

Your assistant reads a repo and writes facts: what it serves, calls and stores, the fields that cross each boundary, where it deploys, and the flows through it. Each fact gives its file, its line, the value it claims and a quote.

`atticus verify` checks every one: that the file exists at that commit, that the claimed value is on the cited line, that the quote matches, that references resolve and that no secret is quoted. A fact that doesn't hold is rejected and goes back to the assistant with the reason. Then `atticus verify --write` puts the kept facts in the catalog and renders the map for review in a pull request.

## The map

The catalog drawn as a map: each repo's entries and calls, the flows through it, OpenAPI contracts, and, with several repos read, each call joined to the repo that serves it, citing both ends. Where a host matches no repo, Atticus asks a person rather than guessing. `atticus join` follows flows from repo to repo.

## A change

A change runs in three stages: the feature, the architecture, then stories and tasks. In each, the assistant drafts, Atticus checks the draft against the code, the critic argues, and open points become questions for a person. A stage closes when its hand-off pull request merges.

A change is an [OpenSpec](https://github.com/Fission-AI/openspec) change. Its stories carry Given/When/Then acceptance criteria, error cases included, and each task names the files to touch and the command to run. See [a change in OpenSpec](./guide/openspec.md).

## The critic

At each gate the critic asks four questions: is it true to the code, is it complete, is it safe to build, can it ship. Code answers what it can, then one AI lens per question reads the rest in a fresh session. A finding stays open until a person decides: an AI's attempt to close one is recorded as a proposal, and the rules of the built-in constitution can't be waived.

## People approve

Atticus has no sign-in and no roles. You are your Git user, and a gate is approved by merging its pull request, so your Git host's branch protection and code owners decide who may approve. Every write to a shared system, such as the Git host, a work tracker or a service desk, is a dry run until a person confirms it. AI never pushes to a protected branch or deploys. See [how approving works](./guide/admin.md#who-you-are-and-how-approving-works).

## Knowledge

`atticus knowledge scan` reads your wikis and documents into patterns, standards, decisions, processes and requests, each quote checked word for word against its page. Each stage, and each task, gets the items that apply to it, and you confirm or exclude them. A document never overrides a fact verified from code. See [org knowledge](./guide/knowledge.md).

## Any assistant

Claude Code, Cursor or Copilot agent mode open files and run commands, so a repo is read in one session. Copilot Chat without tools gets the repo in batches that fit its model, and any other chat gets the same batches to copy and paste. `atticus probe` measures which of these your assistant can do. Every way writes the same facts and gets the same checks; only the speed differs. See [installing Atticus](./guide/install.md#the-first-map-by-tier).

## What Atticus never does

These can't be configured away: it never connects to live databases, consoles or monitoring; a scan reads files only, and the only network call a read makes is to the model provider you configure, if any; ingested content is data, never instructions; and a person approves every write to a shared system.
