# Atticus guides

- [Installing Atticus](install.md): from minute 0 to a first map and a first change, for each kind of assistant; the offline bundle, the probe, upgrades.
- [Running Atticus for a team](admin.md): the setup checklist, the org pack, what AI may do, who you are and how approving works, logs and support.
- [Choosing models at an organisation on Copilot](models.md): the five kinds of AI step, a default model for each and the cost reasoning, and how a person overrides one.
- [Running Atticus's steps through Copilot agent mode](copilot-agent-mode.md): the agent files Copilot reads, the setup, the checklist a person runs in a real Copilot session, and the limits.
- [Teaching Atticus your house frameworks](frameworks.md): framework models from source, JARs, documents or an assistant's draft, and the tests that gate them.
- [Org knowledge](knowledge.md): add a wiki, a document or an API guide, scan it, ask it, and see, confirm or exclude what applies to a change.
- [A vendor's API changes](vendor-specs.md): feed each version of a vendor's spec beside the last, see what changed and what in the estate it reaches, and start a change from it.
- [Starting from a prototype](prototypes.md): compare a working prototype (a UI, its BFF, SSO and mocks) with the estate, and attach what exists, changes, is new or only a vendor provides to a change.
- [Contracts and traffic as evidence for links](link-evidence.md): Pact files and a consumer's OpenAPI specs confirm links or show where they disagree; a gateway's traffic export, kept only as counts, shows links used, unused and missing.
- [Another team's map, read-only](shared-maps.md): bring in the Atticus map a team that owns a system you call shares, as files; your calls to that system join their entries, cited on their lines, and stay theirs to change.
- [Measuring your map on your own estate](measure.md): list a few known repos' entries and calls, each with the repo it should reach, and score the map's reading recall and join precision and recall against it.
- [Atticus by kind of work](roles.md): who you are in Atticus (your Git user), approving by pull request, and the screens and first steps for each kind of work.
- [Atticus in IntelliJ IDEA](intellij.md): the tool window's tabs, what is native, how an AI step runs through Copilot Chat or Claude Code there, and the two things only VS Code does.
- [A change in OpenSpec](openspec.md): the artifacts each stage writes, starting a change from your own analysis (attach it; code wins), how a change's specs accumulate in openspec/specs, and exporting the stories to Azure DevOps or Jira.
- [Troubleshooting](troubleshooting.md): what an error means and what to do.
- [Command reference](commands.md): the twelve commands `atticus help` shows, then every other `atticus` command, generated from its help.
- [The catalog query language](../query-language.md).
- [Threat model](../security/threat-model.md).

The specification (contracts and concepts) is in [docs/spec](../spec/README.md); decisions are in [docs/adr](../adr).
