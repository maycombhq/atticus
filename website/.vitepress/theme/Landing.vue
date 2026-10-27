<script setup lang="ts">
// The landing page. Every claim here is one the guides show working, and each links to the page
// that shows it. The guide list comes from the guide index (docs/guide/README.md) via the config.
import { useData, withBase } from "vitepress";

const { theme } = useData();
const github = "https://github.com/maycombhq/atticus";

type Guide = { text: string; link: string; desc: string };
const guides = (theme.value.guideIndex ?? []) as Guide[];

/** One line of the guide index as HTML: escaped, with `code` kept as code. */
function line(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
}

const does = [
  {
    term: "Reads your repos into facts that cite their line",
    body: "Your assistant reads each repo and writes what it serves, calls and stores. Every fact gives its file, its line, the value it claims and a quote. `atticus verify` checks each claim on that line and rejects what doesn't hold; what it keeps becomes the map.",
    link: "/guide/install.html#the-first-map-by-tier",
    linkText: "The first map",
  },
  {
    term: "Stories and tasks you can build from",
    body: "A change runs through feature, architecture, then stories and tasks, as an OpenSpec change. Each story has Given/When/Then acceptance criteria, error cases included, and each task names the files to touch and the command to run.",
    link: "/guide/openspec.html",
    linkText: "A change in OpenSpec",
  },
  {
    term: "A critic that a person, not the AI, has to clear",
    body: "At each gate a critic asks whether the change is true to the code, complete, safe to build and able to ship. An AI's attempt to close a finding is only a proposal: the finding stays open until a person decides, and a gate opens when its pull request merges.",
    link: "/guide/admin.html#who-you-are-and-how-approving-works",
    linkText: "How approving works",
  },
  {
    term: "Your wikis, indexed and tagged to every task",
    body: "Atticus reads your wikis and documents into knowledge items, each quote checked word for word against its page. Each task gets the how-tos, standards and decisions that bear on its own step, and when two pages disagree and the code doesn't settle it, a person is asked.",
    link: "/guide/knowledge.html#_7-knowledge-per-story-and-per-task",
    linkText: "Knowledge per task",
  },
  {
    term: "In VS Code and IntelliJ, with Copilot or Claude Code",
    body: "The same commands and checks in both editors. The AI steps run in the assistant you already have: Copilot Chat or agent mode, Claude Code, or any chat you can paste into.",
    link: "/guide/intellij.html",
    linkText: "Atticus in IntelliJ",
  },
  {
    term: "Installs from npm, behind your company's mirror too",
    body: "One package from the public registry or your Artifactory or Nexus mirror, with no install scripts and nothing downloaded after install. A machine with no registry takes the offline zip instead.",
    link: "/guide/install.html#minute-2-install",
    linkText: "Installing Atticus",
  },
];

const practice = [
  "npm install -g @maycombhq/atticus@beta",
  "atticus sandbox create ./practice",
  "cd practice/metarepo",
  "atticus doctor",
  "atticus next",
  "atticus ui --open",
].join("\n");

const steps = [
  {
    title: "Make the team's metarepo",
    code: "atticus init forge-meta --platform forge --owner <you>\ncd forge-meta",
  },
  {
    title: "List your repos and clone them",
    code: "atticus repos discover <folder with your clones>\natticus workspace sync",
  },
  { title: "Check the machine", code: "atticus doctor" },
  { title: "Measure what your assistant can do", code: "atticus probe" },
  {
    title: "Read a repo, then verify it",
    code: "/atticus-map <repo>                # in your assistant\natticus verify <repo> --write",
  },
  {
    title: "Start a change",
    code: 'atticus change new "Cap daily transfers" --type feature\natticus next',
  },
];
</script>

<template>
  <main class="landing">
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-words">
        <h1 id="hero-title">
          Your assistant reads the code. Atticus checks every fact against the line it cites.
        </h1>
        <p class="lede">
          Then it runs each change from idea to stories and tasks on that map, indexes your wikis
          and tags each task with the pages that bear on it, and puts a critic that argues the other
          side and a person's approval at every gate. Open source, spec-driven development built on
          OpenSpec, for teams whose systems span many repositories.
        </p>
        <p class="actions">
          <a class="btn btn-primary" href="#start">Install Atticus</a>
          <a class="btn" :href="withBase('/concepts.html')">What Atticus is</a>
        </p>
      </div>

      <figure class="fact bracketed" aria-labelledby="fact-caption">
        <figcaption id="fact-caption">
          Two facts an assistant wrote about one file, as <code>atticus verify</code> judges them
        </figcaption>
        <p class="file">forge-ledger/src/main/java/forge/ledger/NorthwindClient.java</p>
        <pre
          class="lines"
          aria-label="Lines 8 to 12 of the file"
        ><span class="ln cited-refused"><span class="no">8</span>  @ForgeCall(method = "POST", path = "/v2/payments")</span><span class="ln"><span class="no">9</span>  PaymentResult pay(PaymentRequest request);</span><span class="ln"><span class="no">10</span></span><span class="ln cited-kept"><span class="no">11</span>  @ForgeCall(method = "POST", path = "/v2/refunds")</span><span class="ln"><span class="no">12</span>  RefundResult refund(RefundRequest request);</span></pre>
        <ul class="verdicts">
          <li class="refused">
            <span class="word">Rejected</span>
            <span class="claim">Calls Northwind Pay at <code>POST /v2/payouts</code>, line 8.</span>
            <span class="why"
              >Line 8 says <code>/v2/payments</code>. The fact goes back to the assistant with the
              reason.</span
            >
          </li>
          <li class="kept">
            <span class="word">Kept</span>
            <span class="claim"
              >Calls Northwind Pay at <code>POST /v2/refunds</code>, line 11.</span
            >
            <span class="why">The path is on line 11 and the quote matches.</span>
          </li>
        </ul>
        <p class="note">From the invented Forge estate in Atticus's test fixtures.</p>
      </figure>
    </section>

    <section class="screens" aria-labelledby="screens-title">
      <h2 id="screens-title">In VS Code, and in your browser</h2>
      <figure class="shot shot-main">
        <a :href="withBase('/screens/vscode-change.webp')">
          <img
            :src="withBase('/screens/vscode-change.webp')"
            width="1439"
            height="899"
            loading="lazy"
            alt="VS Code with the Atticus sidebar (next steps, questions and the change Add a daily transfer limit with its artifacts) and the Atticus app open in an editor tab on the change's page: its stages from define to release, its risk and its artifacts."
          />
        </a>
        <figcaption>
          A change in VS Code: the sidebar says what's next and what waits on you; the app opens in
          a tab beside your code.
        </figcaption>
      </figure>
      <div class="shot-row">
        <figure class="shot">
          <a :href="withBase('/screens/vscode-stories.webp')">
            <img
              :src="withBase('/screens/vscode-stories.webp')"
              width="1439"
              height="899"
              loading="lazy"
              alt="VS Code showing the change's stories.md as a table of four stories, each with the repos it touches and the story it depends on."
            />
          </a>
          <figcaption>Stories are OpenSpec files in your metarepo, reviewed like code.</figcaption>
        </figure>
        <figure class="shot">
          <a :href="withBase('/screens/vscode-map.webp')">
            <img
              :src="withBase('/screens/vscode-map.webp')"
              width="1439"
              height="899"
              loading="lazy"
              alt="The estate canvas in VS Code: the Portal, Reports, Audit, Ledger and Northwind Pay systems with the calls and subscriptions between them, and one call flagged as missing something."
            />
          </a>
          <figcaption>The map of your systems, built from verified facts.</figcaption>
        </figure>
        <figure class="shot">
          <a :href="withBase('/screens/app-task-board.webp')">
            <img
              :src="withBase('/screens/app-task-board.webp')"
              width="1440"
              height="900"
              loading="lazy"
              alt="The task board in the browser: five tasks across forge-ledger and forge-portal-bff, each tied to a story, each with Run with AI."
            />
          </a>
          <figcaption>
            The same app in your browser: <code>atticus ui</code>. Here, the task board.
          </figcaption>
        </figure>
      </div>
      <p class="shot-note">
        On the invented Forge practice estate: <code>atticus sandbox create</code>.
      </p>
    </section>

    <section class="does" aria-labelledby="does-title">
      <h2 id="does-title">What it does</h2>
      <dl>
        <div v-for="d in does" :key="d.term" class="does-row">
          <dt>{{ d.term }}</dt>
          <dd>
            <p v-html="line(d.body)" />
            <p class="more">
              <a :href="withBase(d.link)">{{ d.linkText }}</a>
            </p>
          </dd>
        </div>
      </dl>
    </section>

    <section id="start" class="start" aria-labelledby="start-title">
      <h2 id="start-title">Start</h2>
      <p class="needs">
        You need Node.js 22.13 or later and Git 2.30 or later. No administrator rights.
        <a :href="withBase('/guide/install.html')">The install guide</a> covers your company's npm
        mirror, a proxy and the offline bundle.
      </p>

      <div class="start-grid">
        <div class="practice">
          <h3>Try it on a practice estate</h3>
          <p>The invented Forge estate, with no outside system reached.</p>
          <pre class="code bracketed"><code>{{ practice }}</code></pre>
        </div>

        <div class="own">
          <h3>Then on your own repos</h3>
          <ol class="steps">
            <li v-for="s in steps" :key="s.title">
              <span class="step-title">{{ s.title }}</span>
              <pre class="code"><code>{{ s.code }}</code></pre>
            </li>
          </ol>
        </div>
      </div>
    </section>

    <section class="guides" aria-labelledby="guides-title">
      <h2 id="guides-title">Guides</h2>
      <ul class="guide-list">
        <li v-for="g in guides" :key="g.link">
          <a :href="withBase(g.link + '.html')">{{ g.text }}</a>
          <span v-if="g.desc" class="desc" v-html="line(g.desc)" />
        </li>
      </ul>
    </section>

    <section class="source" aria-labelledby="source-title">
      <h2 id="source-title">Open source</h2>
      <p>
        Atticus is under the <a :href="`${github}/blob/main/LICENSE`">Apache 2.0 licence</a>. The
        code, the <a :href="`${github}/tree/main/docs/adr`">decisions</a> and
        <a :href="`${github}/blob/main/docs/build-status.md`">where it stands</a> are on
        <a :href="github">GitHub</a>. It is in beta, and
        <a :href="withBase('/overview.html#measured-with-the-caveats')">its measurements</a> say
        which bars it doesn't meet yet.
      </p>
      <p class="name">
        The name comes from Atticus Finch, the honest advocate in
        <cite>To Kill a Mockingbird</cite>.
      </p>
    </section>
  </main>
</template>

<style scoped>
.landing {
  position: relative;
  isolation: isolate;
  max-width: 1152px;
  margin: 0 auto;
  padding: 48px 24px 96px;
  color: var(--a-text);
}
/* The same soft cyan light as the MaycombHQ home, from the top right. */
.landing::before {
  content: "";
  position: absolute;
  z-index: -1;
  top: -64px;
  right: -20vw;
  width: min(68rem, 120vw);
  height: 40rem;
  background: radial-gradient(closest-side, var(--a-glow), transparent);
  pointer-events: none;
}

h2 {
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0 0 24px;
  padding-top: 16px;
  border-top: 1px solid var(--a-line);
}
h3 {
  font-size: 1.0625rem;
  font-weight: 600;
  margin: 0 0 8px;
}
a {
  color: var(--a-cite);
  text-decoration: underline;
  text-underline-offset: 3px;
}
a:hover {
  color: var(--a-cite-strong);
}
code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.86em;
}

/* The hero: the claim on the left, the checked fact on the right. */
.hero {
  display: grid;
  gap: 40px;
  align-items: start;
  margin-bottom: 72px;
}
/* Grid children may shrink below their code's width; the code scrolls inside its own box. */
.hero > *,
.start-grid > *,
.steps li {
  min-width: 0;
}
@media (min-width: 960px) {
  .hero {
    grid-template-columns: 5fr 6fr;
    gap: 56px;
    padding-top: 24px;
  }
}
/* The claim and the lede as the first two lines of a file, numbered in a gutter, as on the
   MaycombHQ home: a claim names the line it comes from. */
.hero-words {
  --gutter: 44px;
  position: relative;
  counter-reset: line;
}
.hero h1::after,
.lede::after {
  content: "";
  position: absolute;
  top: 0.15em;
  bottom: -24px;
  left: calc(var(--gutter) - 14px);
  border-left: 1px solid var(--a-line);
}
.lede::after {
  bottom: 0.2em;
}
.hero h1,
.lede {
  counter-increment: line;
  position: relative;
  padding-left: var(--gutter);
}
.hero h1::before,
.lede::before {
  content: counter(line);
  position: absolute;
  left: 0;
  width: calc(var(--gutter) - 28px);
  text-align: right;
  font: 400 0.8125rem/1 var(--vp-font-family-mono);
  letter-spacing: 0;
  color: var(--a-muted);
}
.hero h1::before {
  top: 0.62em;
  font-size: 0.8125rem;
}
.lede::before {
  top: 0.55em;
}
.actions {
  padding-left: var(--gutter);
}
@media (max-width: 640px) {
  .hero-words {
    --gutter: 30px;
  }
}
.hero h1 {
  font-size: clamp(2.125rem, 1.3rem + 3vw, 3.5rem);
  line-height: 1.08;
  font-weight: 600;
  letter-spacing: -0.03em;
  margin: 0 0 24px;
  max-width: 19ch;
}
.lede {
  font-size: 1.125rem;
  line-height: 1.6;
  color: var(--a-muted);
  max-width: 52ch;
  margin: 0 0 28px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 0;
}
.btn {
  display: inline-block;
  padding: 10px 18px;
  border: 1px solid var(--a-line);
  border-radius: 4px;
  font-weight: 600;
  text-decoration: none;
  color: var(--a-text);
  background: var(--a-panel);
}
.btn:hover {
  border-color: var(--a-cite);
  color: var(--a-text);
}
.btn-primary {
  background: var(--a-cite);
  border-color: var(--a-cite);
  color: var(--a-ink);
}
.btn-primary:hover {
  background: var(--a-cite-strong);
  border-color: var(--a-cite-strong);
  color: var(--a-ink);
}

/* The checked fact. */
.fact {
  margin: 0;
  background: var(--a-panel);
  border: 1px solid var(--a-line);
  padding: 20px 20px 16px;
  min-width: 0;
}
.fact figcaption {
  font-size: 0.875rem;
  color: var(--a-muted);
  margin-bottom: 14px;
}
.file {
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
  color: var(--a-muted);
  margin: 0 0 6px;
  overflow-wrap: anywhere;
}
.lines {
  margin: 0 0 16px;
  padding: 10px 0;
  background: var(--a-sunk);
  border: 1px solid var(--a-line);
  font-family: var(--vp-font-family-mono);
  font-size: 0.8125rem;
  line-height: 1.7;
  overflow-x: auto;
}
.ln {
  display: block;
  padding: 0 14px 0 0;
  border-left: 3px solid transparent;
  white-space: pre;
}
.no {
  display: inline-block;
  width: 3.2ch;
  margin-right: 1ch;
  text-align: right;
  color: var(--a-muted);
  user-select: none;
}
.cited-kept {
  border-left-color: var(--a-kept);
  background: var(--a-cite-wash);
}
.cited-refused {
  border-left-color: var(--a-refused);
  text-decoration: line-through var(--a-refused);
  text-decoration-thickness: 1px;
}
.cited-refused .no {
  color: var(--a-refused);
}

/* The page's one moment of motion: verify checks line 8 and rejects it, then line 11 and keeps
   it, then says why. The resting styles are the result, so with reduced motion (style.css turns
   animation off) the figure shows the verdicts at once. */
.cited-refused {
  animation: refuse 1.6s ease 0.5s both;
}
.cited-refused .no {
  animation: refuse-no 1.6s ease 0.5s both;
}
.cited-kept {
  animation: keep 1.2s ease 2s both;
}
.verdicts .refused {
  animation: appear 0.4s ease 1.7s both;
}
.verdicts .kept {
  animation: appear 0.4s ease 3s both;
}
@keyframes refuse {
  0% {
    border-left-color: transparent;
    background: transparent;
    text-decoration-color: transparent;
  }
  25%,
  60% {
    border-left-color: var(--a-cite);
    background: var(--a-cite-wash);
    text-decoration-color: transparent;
  }
  75%,
  100% {
    border-left-color: var(--a-refused);
    background: transparent;
    text-decoration-color: var(--a-refused);
  }
}
@keyframes refuse-no {
  0%,
  60% {
    color: var(--a-muted);
  }
  75%,
  100% {
    color: var(--a-refused);
  }
}
@keyframes keep {
  0% {
    border-left-color: transparent;
    background: transparent;
  }
  40%,
  70% {
    border-left-color: var(--a-cite);
    background: var(--a-cite-wash);
  }
  100% {
    border-left-color: var(--a-kept);
    background: var(--a-cite-wash);
  }
}
@keyframes appear {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.verdicts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 12px;
}
.verdicts li {
  display: grid;
  grid-template-columns: 5.5rem 1fr;
  column-gap: 12px;
  row-gap: 2px;
  font-size: 0.9375rem;
  line-height: 1.5;
}
.verdicts .word {
  grid-row: span 2;
  font-weight: 600;
}
.kept .word {
  color: var(--a-kept);
}
.refused .word {
  color: var(--a-refused);
}
.verdicts .why {
  color: var(--a-muted);
}
.note {
  margin: 14px 0 0;
  font-size: 0.8125rem;
  color: var(--a-muted);
}

/* Screenshots: one large, three below. */
.screens {
  margin-bottom: 72px;
}
.shot {
  margin: 0;
  min-width: 0;
}
.shot a {
  display: block;
  border: 1px solid var(--a-line);
  background: var(--a-sunk);
}
.shot img {
  display: block;
  width: 100%;
  height: auto;
}
.shot figcaption {
  margin-top: 10px;
  font-size: 0.9375rem;
  line-height: 1.5;
  color: var(--a-muted);
  max-width: 72ch;
}
.shot-main {
  margin-bottom: 32px;
}
.shot-main a {
  box-shadow: 0 24px 60px -30px rgba(0, 40, 50, 0.45);
}
.shot-row {
  display: grid;
  gap: 28px;
}
@media (min-width: 768px) {
  .shot-row {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
.shot-note {
  margin: 20px 0 0;
  font-size: 0.875rem;
  color: var(--a-muted);
}

/* What it does: a two-column list of terms and what they mean. */
.does {
  margin-bottom: 72px;
}
.does dl {
  margin: 0;
}
.does-row {
  display: grid;
  gap: 4px 40px;
  padding: 20px 0;
  border-bottom: 1px solid var(--a-line);
}
.does-row:first-child {
  padding-top: 0;
}
@media (min-width: 768px) {
  .does-row {
    grid-template-columns: minmax(0, 4fr) minmax(0, 7fr);
  }
}
.does dt {
  font-weight: 600;
  font-size: 1.0625rem;
  line-height: 1.4;
}
.does dd {
  margin: 0;
}
.does dd p {
  margin: 0;
  line-height: 1.65;
  max-width: 68ch;
}
.does .more {
  margin-top: 6px;
  font-size: 0.9375rem;
}

/* Start. */
.start {
  margin-bottom: 72px;
}
.needs {
  max-width: 72ch;
  line-height: 1.65;
  margin: 0 0 28px;
}
.start-grid {
  display: grid;
  gap: 40px;
}
@media (min-width: 960px) {
  .start-grid {
    grid-template-columns: 5fr 6fr;
    gap: 56px;
  }
}
.practice p {
  margin: 0 0 12px;
  color: var(--a-muted);
}
.code {
  margin: 0;
  padding: 14px 16px;
  background: var(--a-sunk);
  border: 1px solid var(--a-line);
  font-family: var(--vp-font-family-mono);
  font-size: 0.8125rem;
  line-height: 1.7;
  overflow-x: auto;
  white-space: pre;
}
.steps {
  margin: 0;
  padding-left: 1.5rem;
  list-style: decimal;
  display: grid;
  gap: 16px;
}
.steps li::marker {
  color: var(--a-muted);
  font-weight: 600;
}
.step-title {
  display: block;
  font-weight: 600;
  margin-bottom: 6px;
}

/* Guides. */
.guides {
  margin-bottom: 72px;
}
.guide-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 18px 40px;
}
@media (min-width: 768px) {
  .guide-list {
    grid-template-columns: 1fr 1fr;
  }
}
.guide-list a {
  font-weight: 600;
}
.guide-list .desc {
  display: block;
  margin-top: 4px;
  color: var(--a-muted);
  line-height: 1.55;
  font-size: 0.9375rem;
}

.source p {
  max-width: 72ch;
  line-height: 1.65;
  margin: 0 0 12px;
}
.source .name {
  color: var(--a-muted);
}
</style>
