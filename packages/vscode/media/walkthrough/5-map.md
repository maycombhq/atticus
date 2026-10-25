# Map the repos

**Map a repo** (`@atticus /map <repo>`) has Copilot read the repo and write its facts: endpoints, calls, tables, topics, settings and flows, each with the file, the line and the words it read there.

**Verify it** (`@atticus /verify <repo>`) checks each fact against its line, then puts the facts in the catalog and draws the map. See it in the app's **Map**: every flow as a diagram, every step citing its code.

These are two of the command line's twelve commands (`atticus help` lists them). The others plan and build a change: `change`, `critic`, `stories`, `task`, with `questions`, `knowledge`, `next` and `ui` beside them.

Questions only a person can answer appear in the **Questions** section; the open needs, manual steps, findings and knowledge to verify are under **Waiting on you** in **Next and Waiting**.
