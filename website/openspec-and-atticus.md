---
aside: false
pageClass: arch-page
---

# OpenSpec and Atticus

Atticus is built on [OpenSpec](https://github.com/Fission-AI/openspec), and doesn't replace it: every Atticus change is a plain OpenSpec change. What Atticus adds is what OpenSpec leaves to the team: a map of every repo that is checked against the code, the team's standards from its wikis, and a reviewed path from an idea to tasks.

## How OpenSpec works

One repo, three commands, Markdown in Git.

<figure class="arch">
<svg viewBox="0 0 1200 675" role="img" aria-labelledby="arch-os-t"><title id="arch-os-t">OpenSpec: a developer and an AI assistant run /opsx:propose, /opsx:apply and /opsx:archive inside one code repo. Propose writes a proposal, spec deltas, a design and tasks under openspec/changes; apply changes the code; archive merges the deltas into openspec/specs. Left to the team: checking the AI against the code, other repos, standards in wikis, and review.</title>
<defs><marker id="ah-os" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="ahead"/></marker></defs>
<rect class="actor" x="30" y="70" width="190" height="78" rx="8"/>
<text class="bt" x="125.0" y="95.0" text-anchor="middle">Developer</text>
<text class="bl" x="125.0" y="113.0" text-anchor="middle">writes the idea,</text>
<text class="bl" x="125.0" y="131.0" text-anchor="middle">reviews every file</text>
<rect class="actor" x="30" y="200" width="190" height="96" rx="8"/>
<text class="bt" x="125.0" y="225.0" text-anchor="middle">AI assistant</text>
<text class="bl" x="125.0" y="243.0" text-anchor="middle">Copilot, Claude, Cursor</text>
<text class="bl" x="125.0" y="261.0" text-anchor="middle">reads what it opens</text>
<text class="bl" x="125.0" y="279.0" text-anchor="middle">or what you paste</text>
<path class="arr" d="M125 148 V196" marker-end="url(#ah-os)"/>
<rect class="zone" x="260" y="30" width="910" height="470" rx="12"/>
<text class="zlab" x="280" y="56" text-anchor="start">ONE CODE REPO</text>
<rect class="pill" x="300" y="76" width="210" height="40" rx="20"/>
<text class="mono" x="405.0" y="100.0" text-anchor="middle">/opsx:propose</text>
<rect class="pill" x="610" y="76" width="210" height="40" rx="20"/>
<text class="mono" x="715.0" y="100.0" text-anchor="middle">/opsx:apply</text>
<rect class="pill" x="920" y="76" width="210" height="40" rx="20"/>
<text class="mono" x="1025.0" y="100.0" text-anchor="middle">/opsx:archive</text>
<path class="arr" d="M512 96 H606" marker-end="url(#ah-os)"/>
<path class="arr" d="M822 96 H916" marker-end="url(#ah-os)"/>
<path class="arr" d="M222 248 C 260 248, 270 96, 296 96" marker-end="url(#ah-os)"/>
<text class="lab" x="250" y="196" text-anchor="middle">runs</text>
<rect class="file" x="300" y="160" width="240" height="206" rx="8"/>
<text class="bt" x="314" y="222.0" text-anchor="start">openspec/changes/&lt;name&gt;/</text>
<text class="mono" x="314" y="240.0" text-anchor="start">proposal.md</text>
<text class="bl" x="314" y="258.0" text-anchor="start">why and what</text>
<text class="mono" x="314" y="276.0" text-anchor="start">specs/ (deltas)</text>
<text class="mono" x="314" y="294.0" text-anchor="start">design.md</text>
<text class="mono" x="314" y="312.0" text-anchor="start">tasks.md</text>
<path class="arr" d="M405 118 V156" marker-end="url(#ah-os)"/>
<rect class="box" x="610" y="160" width="210" height="110" rx="8"/>
<text class="bt" x="715.0" y="192.0" text-anchor="middle">Source code</text>
<text class="bl" x="715.0" y="210.0" text-anchor="middle">the assistant works</text>
<text class="bl" x="715.0" y="228.0" text-anchor="middle">through tasks.md</text>
<text class="bl" x="715.0" y="246.0" text-anchor="middle">in this repo</text>
<path class="arr" d="M715 118 V156" marker-end="url(#ah-os)"/>
<path class="arr" d="M542 230 H606" marker-end="url(#ah-os)"/>
<text class="lab" x="574" y="222" text-anchor="middle">tasks</text>
<rect class="file" x="920" y="160" width="220" height="110" rx="8"/>
<text class="bt" x="1030.0" y="201.0" text-anchor="middle">openspec/specs/</text>
<text class="bl" x="1030.0" y="219.0" text-anchor="middle">the source of truth;</text>
<text class="bl" x="1030.0" y="237.0" text-anchor="middle">deltas merged in</text>
<path class="arr" d="M1030 118 V156" marker-end="url(#ah-os)"/>
<rect class="file2" x="920" y="300" width="220" height="64" rx="8"/>
<text class="bl" x="1030.0" y="327.0" text-anchor="middle">changes/archive/</text>
<text class="bl" x="1030.0" y="345.0" text-anchor="middle">&lt;date&gt;-&lt;name&gt;/</text>
<path class="arr" d="M1030 272 V296" marker-end="url(#ah-os)"/>
<path class="loop" d="M300 400 H1140"/>
<text class="lab" x="720" y="392" text-anchor="middle">Edit any artifact at any time: no gates, no fixed stages</text>
<rect class="good" x="300" y="420" width="840" height="56" rx="8"/>
<text class="bl" x="720.0" y="452.0" text-anchor="middle">Lightweight, per repo, works with 20+ assistants, plain Markdown in Git</text>
<text class="zlab" x="30" y="540" text-anchor="start">WHAT IT LEAVES TO THE TEAM</text>
<rect class="gap" x="30" y="556" width="268" height="96" rx="8"/>
<text class="bt" x="164.0" y="590.0" text-anchor="middle">Is the AI right about the code?</text>
<text class="bl" x="164.0" y="608.0" text-anchor="middle">Nothing checks its claims</text>
<text class="bl" x="164.0" y="626.0" text-anchor="middle">against the actual lines.</text>
<rect class="gap" x="317" y="556" width="268" height="96" rx="8"/>
<text class="bt" x="451.0" y="590.0" text-anchor="middle">Other repos, gateways, events</text>
<text class="bl" x="451.0" y="608.0" text-anchor="middle">Outside this repo: only what</text>
<text class="bl" x="451.0" y="626.0" text-anchor="middle">you paste into the chat.</text>
<rect class="gap" x="604" y="556" width="268" height="96" rx="8"/>
<text class="bt" x="738.0" y="590.0" text-anchor="middle">Standards and decisions</text>
<text class="bl" x="738.0" y="608.0" text-anchor="middle">In wikis: only what you</text>
<text class="bl" x="738.0" y="626.0" text-anchor="middle">remember to bring in.</text>
<rect class="gap" x="891" y="556" width="268" height="96" rx="8"/>
<text class="bt" x="1025.0" y="590.0" text-anchor="middle">Review</text>
<text class="bl" x="1025.0" y="608.0" text-anchor="middle">People read the Markdown</text>
<text class="bl" x="1025.0" y="626.0" text-anchor="middle">in the repo&#x27;s pull request.</text>
</svg>
</figure>

## How Atticus works

Every repo, a verified map, the same gate at every stage, and OpenSpec underneath.

<figure class="arch">
<svg viewBox="0 0 1200 700" role="img" aria-labelledby="arch-at-t"><title id="arch-at-t">Atticus: code repos, wikis, the org pack, the AI assistant and people feed a metarepo. The assistant reads each repo into facts citing file and line; a verifier in code checks every claim and throws out wrong ones, giving a verified map of APIs, calls, events, data and flows. Wikis become a knowledge index. A change goes through feature, architecture, stories and tasks, each passing the same gate: a draft, a check against the code, the critic's four questions, questions to people and a person's approval. The output is a plain OpenSpec change, a branch and pull request in each code repo, and stories for Azure DevOps or Jira. It never pushes to protected branches or deploys.</title>
<defs><marker id="ah-at" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="ahead"/></marker></defs>
<rect class="src" x="20" y="60" width="200" height="104" rx="8"/>
<text class="bt" x="120.0" y="89.0" text-anchor="middle">Code repos</text>
<text class="bl" x="120.0" y="107.0" text-anchor="middle">services, gateways, UIs,</text>
<text class="bl" x="120.0" y="125.0" text-anchor="middle">pipelines: every repo</text>
<text class="bl" x="120.0" y="143.0" text-anchor="middle">in the manifest</text>
<rect class="src" x="20" y="190" width="200" height="86" rx="8"/>
<text class="bt" x="120.0" y="219.0" text-anchor="middle">Wikis and docs</text>
<text class="bl" x="120.0" y="237.0" text-anchor="middle">standards, how-tos,</text>
<text class="bl" x="120.0" y="255.0" text-anchor="middle">decisions</text>
<rect class="src" x="20" y="302" width="200" height="104" rx="8"/>
<text class="bt" x="120.0" y="331.0" text-anchor="middle">Org pack</text>
<text class="bl" x="120.0" y="349.0" text-anchor="middle">your frameworks, rules</text>
<text class="bl" x="120.0" y="367.0" text-anchor="middle">and constitution,</text>
<text class="bl" x="120.0" y="385.0" text-anchor="middle">in YAML in Git</text>
<rect class="actor" x="20" y="432" width="200" height="104" rx="8"/>
<text class="bt" x="120.0" y="461.0" text-anchor="middle">Your AI assistant</text>
<text class="bl" x="120.0" y="479.0" text-anchor="middle">Copilot or Claude:</text>
<text class="bl" x="120.0" y="497.0" text-anchor="middle">reads the code and</text>
<text class="bl" x="120.0" y="515.0" text-anchor="middle">drafts each stage</text>
<rect class="actor" x="20" y="562" width="200" height="104" rx="8"/>
<text class="bt" x="120.0" y="600.0" text-anchor="middle">People</text>
<text class="bl" x="120.0" y="618.0" text-anchor="middle">answer open questions,</text>
<text class="bl" x="120.0" y="636.0" text-anchor="middle">approve every gate</text>
<rect class="zone" x="245" y="30" width="715" height="660" rx="12"/>
<text class="zlab" x="262" y="56" text-anchor="start">1 · MAP THE WHOLE ESTATE</text>
<rect class="box" x="262" y="70" width="150" height="100" rx="8"/>
<text class="bt" x="337.0" y="106.0" text-anchor="middle">Assistant reads</text>
<text class="mono" x="337.0" y="124.0" text-anchor="middle">/atticus-map</text>
<text class="bl" x="337.0" y="142.0" text-anchor="middle">one repo at a time</text>
<rect class="box" x="436" y="70" width="150" height="100" rx="8"/>
<text class="bt" x="511.0" y="106.0" text-anchor="middle">Facts</text>
<text class="bl" x="511.0" y="124.0" text-anchor="middle">file, line, value</text>
<text class="bl" x="511.0" y="142.0" text-anchor="middle">and a quote</text>
<rect class="key" x="610" y="70" width="160" height="100" rx="8"/>
<text class="bt" x="690.0" y="97.0" text-anchor="middle">Verifier</text>
<text class="bl" x="690.0" y="115.0" text-anchor="middle">code, not AI: checks</text>
<text class="bl" x="690.0" y="133.0" text-anchor="middle">each claim on the</text>
<text class="bl" x="690.0" y="151.0" text-anchor="middle">line it cites</text>
<rect class="key2" x="794" y="70" width="150" height="100" rx="8"/>
<text class="bt" x="869.0" y="97.0" text-anchor="middle">Verified map</text>
<text class="bl" x="869.0" y="115.0" text-anchor="middle">APIs, calls, events,</text>
<text class="bl" x="869.0" y="133.0" text-anchor="middle">data and flows</text>
<text class="bl" x="869.0" y="151.0" text-anchor="middle">across repos</text>
<path class="arr" d="M412 120 H432" marker-end="url(#ah-at)"/>
<path class="arr" d="M586 120 H606" marker-end="url(#ah-at)"/>
<path class="arr" d="M770 120 H790" marker-end="url(#ah-at)"/>
<rect class="no" x="610" y="186" width="160" height="36" rx="8"/>
<text class="bl" x="690.0" y="208.0" text-anchor="middle">wrong: thrown out</text>
<path class="arr" d="M690 170 V182" marker-end="url(#ah-at)"/>
<text class="lab" x="869" y="190" text-anchor="middle">stored per commit</text>
<rect class="box" x="262" y="236" width="500" height="76" rx="8"/>
<text class="bt" x="512.0" y="260.0" text-anchor="middle">Knowledge index</text>
<text class="bl" x="512.0" y="278.0" text-anchor="middle">standards, patterns, decisions and processes; quotes</text>
<text class="bl" x="512.0" y="296.0" text-anchor="middle">checked word for word, each tagged to its stories</text>
<text class="zlab" x="262" y="342" text-anchor="start">2 · TAKE A CHANGE FROM IDEA TO TASKS</text>
<rect class="stage" x="262" y="354" width="155" height="84" rx="8"/>
<text class="bt" x="339.5" y="382.0" text-anchor="middle">Feature</text>
<text class="bl" x="339.5" y="400.0" text-anchor="middle">brief, scope,</text>
<text class="bl" x="339.5" y="418.0" text-anchor="middle">affected flows</text>
<rect class="stage" x="437" y="354" width="155" height="84" rx="8"/>
<text class="bt" x="514.5" y="382.0" text-anchor="middle">Architecture</text>
<text class="bl" x="514.5" y="400.0" text-anchor="middle">target flows across</text>
<text class="bl" x="514.5" y="418.0" text-anchor="middle">repos, data changes</text>
<path class="arr" d="M417 396 H433" marker-end="url(#ah-at)"/>
<rect class="stage" x="612" y="354" width="155" height="84" rx="8"/>
<text class="bt" x="689.5" y="382.0" text-anchor="middle">Stories</text>
<text class="bl" x="689.5" y="400.0" text-anchor="middle">Given/When/Then,</text>
<text class="bl" x="689.5" y="418.0" text-anchor="middle">error cases</text>
<path class="arr" d="M592 396 H608" marker-end="url(#ah-at)"/>
<rect class="stage" x="787" y="354" width="155" height="84" rx="8"/>
<text class="bt" x="864.5" y="382.0" text-anchor="middle">Tasks</text>
<text class="bl" x="864.5" y="400.0" text-anchor="middle">files to touch,</text>
<text class="bl" x="864.5" y="418.0" text-anchor="middle">per repo</text>
<path class="arr" d="M767 396 H783" marker-end="url(#ah-at)"/>
<path class="arr" d="M700 312 V350" marker-end="url(#ah-at)"/>
<path class="arr" d="M869 196 V350" marker-end="url(#ah-at)"/>
<text class="lab" x="876" y="280" text-anchor="start">every stage</text>
<text class="lab" x="876" y="298" text-anchor="start">reads the map</text>
<rect class="gate" x="262" y="462" width="680" height="104" rx="8"/>
<text class="bt" x="602.0" y="491.0" text-anchor="middle">Every stage passes the same gate</text>
<text class="bl" x="602.0" y="509.0" text-anchor="middle">the assistant drafts → Atticus checks it against the code</text>
<text class="bl" x="602.0" y="527.0" text-anchor="middle">→ the critic asks: is it true, complete, safe, can it ship?</text>
<text class="bl" x="602.0" y="545.0" text-anchor="middle">→ open points go to people → a person approves the hand-off PR</text>
<path class="arr" d="M600 440 V458" marker-end="url(#ah-at)"/>
<rect class="file" x="262" y="590" width="680" height="86" rx="8"/>
<text class="bt" x="602.0" y="619.0" text-anchor="middle">openspec/changes/&lt;id&gt;/  (plain OpenSpec underneath)</text>
<text class="mono" x="602.0" y="637.0" text-anchor="middle">proposal.md · design.md · stories · specs/ · tasks.md</text>
<text class="bl" x="602.0" y="655.0" text-anchor="middle">archive merges the specs into openspec/specs/, as OpenSpec does</text>
<path class="arr" d="M600 568 V586" marker-end="url(#ah-at)"/>
<rect class="src" x="985" y="60" width="195" height="104" rx="8"/>
<text class="bt" x="1082.5" y="89.0" text-anchor="middle">Where you use it</text>
<text class="bl" x="1082.5" y="107.0" text-anchor="middle">VS Code, IntelliJ,</text>
<text class="bl" x="1082.5" y="125.0" text-anchor="middle">command line,</text>
<text class="bl" x="1082.5" y="143.0" text-anchor="middle">web app</text>
<rect class="out" x="985" y="354" width="195" height="104" rx="8"/>
<text class="bt" x="1082.5" y="383.0" text-anchor="middle">Code repos</text>
<text class="mono" x="1082.5" y="401.0" text-anchor="middle">change/&lt;id&gt;</text>
<text class="bl" x="1082.5" y="419.0" text-anchor="middle">branch and a pull</text>
<text class="bl" x="1082.5" y="437.0" text-anchor="middle">request in each repo</text>
<path class="arr" d="M942 396 H981" marker-end="url(#ah-at)"/>
<rect class="gap" x="985" y="470" width="195" height="96" rx="8"/>
<text class="bt" x="1082.5" y="504.0" text-anchor="middle">Never</text>
<text class="bl" x="1082.5" y="522.0" text-anchor="middle">pushes to protected</text>
<text class="bl" x="1082.5" y="540.0" text-anchor="middle">branches or deploys</text>
<rect class="out" x="985" y="590" width="195" height="86" rx="8"/>
<text class="bt" x="1082.5" y="619.0" text-anchor="middle">Your boards</text>
<text class="bl" x="1082.5" y="637.0" text-anchor="middle">stories exported to</text>
<text class="bl" x="1082.5" y="655.0" text-anchor="middle">Azure DevOps or Jira</text>
<path class="arr" d="M942 633 H981" marker-end="url(#ah-at)"/>
<path class="arr" d="M222 118 H258" marker-end="url(#ah-at)"/>
<path class="arr" d="M222 233 C 240 233, 240 274, 258 274" marker-end="url(#ah-at)"/>
<path class="arr" d="M222 354 C 240 354, 240 396, 258 396" marker-end="url(#ah-at)"/>
<path class="arr" d="M222 484 C 240 484, 240 500, 258 500" marker-end="url(#ah-at)"/>
<path class="arr" d="M222 614 C 240 614, 240 540, 258 540" marker-end="url(#ah-at)"/>
</svg>
</figure>

## Side by side

|                   | OpenSpec alone                           | Atticus, with OpenSpec underneath                                                    |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------------------------------ |
| Scope             | One repo at a time                       | Every repo in the manifest: services, gateways, UIs, pipelines                       |
| What the AI knows | What it opens, or what someone pastes in | A map of APIs, calls, events, data and flows across repos                            |
| Is it true?       | Trust the assistant, or check by hand    | Every fact cites a file and line; code checks it, and a wrong one is thrown out      |
| Standards         | Whatever someone remembers to bring in   | Wikis indexed; the standards and decisions that apply are attached to each story     |
| Process           | Propose, apply, archive; no gates        | Feature, architecture, stories, tasks; a critic and a person's sign-off at each      |
| Output            | Markdown in the repo                     | The same OpenSpec change, plus a pull request in each repo and stories for the board |
| To start          | `npm install -g @fission-ai/openspec`    | `npm install -g @maycombhq/atticus@beta`, a metarepo, and a first map of each repo   |

Both work with the assistant you already use, GitHub Copilot or Claude Code among them. OpenSpec is the lighter choice for a single repo. Atticus is for a team whose changes cross many. See [what Atticus is](./concepts.md) and [a change in OpenSpec](./guide/openspec.md) for more.
