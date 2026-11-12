/**
 * The app's copy file: the words a person reads, kept in one place so they stay plain and
 * consistent. New screens take their words from here (CLAUDE.md, definition of done); older
 * screens still hold theirs inline and move here when they are next changed.
 */
export const COPY = {
  /** Words every screen shares: loading, failures, links that leave the app, actions under way. */
  app: {
    /** A page-level note's close (fourth UX walk). */
    dismiss: "Close",
    loading: "Loading",
    /** A list cut short: how many it doesn't show. */
    andMore: (n: number) => `and ${n} more`,
    cantLoad: (why: string) => `Couldn't load this: ${why}`,
    tryAgain: "Try again",
    /** A box that scrolls sideways: the keyboard reaches it, and its name says what it holds. */
    scrollTable: (what: string) => `Table: ${what} (scrolls sideways)`,
    scrollCode: "Code block (scrolls sideways)",
    /** The change picker on the screens that work on one change. */
    changePicker: "Change",
    noChanges: "No changes yet",
    offline:
      "The Atticus server isn't answering. Check that atticus ui is still running in its terminal (start it again with atticus ui if it stopped), then press Try again or reload the page.",
    /** Seventh UX walk: an error with no reason of Atticus's own says what the server answered. */
    serverAnswered: (status: number, words: string) =>
      words
        ? `The server answered ${status}: ${words}`
        : `The server answered ${status}, with no reason given.`,
    notJson: (status: number) =>
      `The server answered with something that isn't Atticus's (status ${status}). Check that the address is the one atticus ui printed.`,
    offlinePanel:
      "The Atticus server the extension started isn't answering. Run Atticus: Open the app from the Command Palette to start it again, then press Try again.",
    offlineShort: "the server isn't answering (the note at the top says how to fix it)",
    online: "The server is answering again.",
    /** Review of beta.23: a write run as a job ended without its answer (stopped, or it broke). */
    jobEnded: (state: string, words: string) =>
      words
        ? `It ${state === "cancelled" ? "was stopped" : "failed"}: ${words}`
        : state === "cancelled"
          ? "It was stopped before it finished."
          : "It failed; the Console has what it printed.",
    working: "Working on it…",
    ccReading: "Reading your metarepo…",
    ccCantRead: "Couldn't read what needs attention: each panel below says why.",
    notLoaded: "not loaded",
    checking: "Checking…",
    checkedAt: (time: string) => `Checked again at ${time}.`,
    newTab: "(opens in a new tab)",
    askEmpty: "Type a question first.",
    tourEscape: "Esc closes the tour",
    needId:
      "Type a record id first, for example ledger-db.account. The Knowledge explorer finds one.",
    needFolder: "Type the folder for the sandbox first: a new, empty one.",
    noExecutors: "No tool is set up on this machine yet, so there is nothing to check.",
    forceSnow: "To replace it, tick “Replace a snow.md a person edited” and draft again.",
    forceStories: (change: string) =>
      `Edit ${change}'s stories on Stories, or replace them with Draft the stories again.`,
    panelNoSave: (file: string, command: string) =>
      `The VS Code panel can't save files, so ${file} wasn't saved. Copy the text below into a file, or run ${command} in a terminal.`,
  },
  /**
   * Seventh UX walk: a change file's status chip. Ready or blocked says what the phase allows; a
   * file that isn't there, or holds only the template, says so.
   */
  artifactStatus: {
    written: "Written",
    notWritten: "Not written yet",
    needsWork: "Written, not passing yet",
    ready: "Can be written now",
    blocked: "Waits on an earlier stage",
    notRequired: "Not needed",
  },
  /** The theme switch in the top bar (the browser app only: a VS Code panel follows the editor). */
  theme: {
    label: "Theme",
    hint: "System follows your computer's light or dark setting.",
    choices: { system: "System", light: "Light", dark: "Dark" },
  },
  /** What a person does with a critic finding. */
  findings: {
    needsReason: "Not relevant and Waive need a reason: type it above first.",
    cantWaive: "This rule can't be waived",
  },
  /** The Flows screen (ADR 0092): a repo's spec flows, each drawn as a sequence of steps. */
  flows: {
    title: "Flows",
    intro:
      "Each flow is what happens, step by step, when something starts it: who calls, what the code does, and the components, tables and topics it reaches. Every step cites the file and line it was read from.",
    repo: "Repo",
    filter: "Find a flow",
    filterHint: "Name, id or what starts it",
    listTitle: "Flows",
    noSpecs:
      "No repo has a spec yet. Draft one with atticus spec draft <repo>, or /atticus-spec in Copilot Chat or Claude Code.",
    noFlows: "This repo's spec has no flows yet.",
    /** Seventh UX walk: the spec step writes a repo's flows; offered where there are none. */
    noFlowsSpec: (repo: string) =>
      `Its spec step reads ${repo} and writes its flows, one per trigger, each step cited. A change's diagram can take a step out of a flow only once the flow is here.`,
    noMatch: "No flow matches. Try part of its name or what starts it.",
    pick: "Pick a flow from the list to see its steps.",
    counts: (steps: number, confirmed: number) =>
      `${steps} step${steps === 1 ? "" : "s"}, ${confirmed} confirmed`,
    unreadable: "These files don't read:",
    file: "File",
    copyFile: "Copy the file's path",
    calledBy: "Called by",
    notJoined:
      "The estate pass hasn't run, so calls to other repos aren't linked to their flows. Join them here.",
    start: "Start",
    goesTo: (label: string, lane: string) => `Goes to ${label} on ${lane}.`,
    backTo: (lane: string) => `Goes back to ${lane}.`,
    opens: (name: string, repo: string) => `Opens "${name}" in ${repo}`,
    unjoined: (why: string) => `Not linked to a flow: ${why}`,
    more: (n: number) => `and ${n} more`,
    confirmed: {
      check: "Confirmed by the check",
      ai: "Confirmed by the AI",
      person: "Confirmed by a person",
    } as Record<string, string>,
    notConfirmed: "Not confirmed yet",
    errorsTitle: "When it goes wrong",
    noErrors: "The spec names no error paths for this flow.",
    diagram: (name: string) => `The steps of ${name}`,
    lanes: {
      caller: "starts it",
      gateway: "gateway",
      self: "runs the flow",
      component: "called",
      store: "table",
      topic: "topic",
    } as Record<string, string>,
    kinds: {
      endpoint: "Endpoint",
      action: "Action",
      page: "Page",
      listener: "Listener",
      job: "Job",
      entry: "Entry",
      lookup: "Lookup",
      read: "Read",
      write: "Write",
      "call-out": "Call",
      publish: "Publish",
      transform: "Transform",
      validate: "Validate",
      branch: "Branch",
      log: "Log",
      respond: "Respond",
      loop: "Loop",
      retry: "Retry",
    } as Record<string, string>,
    openFlows: "Flows of this repo",
    // ADR 0095: loops and retries, and a change's target flows.
    frame: (kind: string, from: number, to: number) =>
      `${kind === "retry" ? "Retry" : "Loop"}: steps ${from} to ${to} again`,
    marks: { added: "Added", changed: "Changed", removed: "Removed" } as Record<string, string>,
    was: (what: string) => `Before: ${what}`,
    newLane: "new",
    change: "Change",
    pickRepo: "A repo's flows",
    changeIntro:
      "The flows this change adds, changes or removes, each drawn beside today's: added steps say Added, changed ones say Changed with what they did before, removed ones say Removed and are struck through.",
    noTargets: (change: string) =>
      `${change} has no target flows yet. The change's architecture stage writes them:`,
    targetsTitle: "Target flows",
    targetCounts: (added: number, changed: number, removed: number) =>
      [
        added ? `${added} added` : "",
        changed ? `${changed} changed` : "",
        removed ? `${removed} removed` : "",
      ]
        .filter(Boolean)
        .join(", ") || "no step changes",
    deltaKinds: { new: "New flow", modify: "Changed flow", remove: "Removed flow" } as Record<
      string,
      string
    >,
    whyChange: "Why",
    openTargets: "Its target flows",
  },
  questions: {
    /** ADR 0144 (Q5): the answer the assistant proposed, for a person to confirm. */
    proposal: {
      title: "Proposed by your assistant",
      listed: "An answer is proposed",
      notYet: (by: string) =>
        `${by} read the code and proposes this. It is not an answer until you accept it.`,
      option: (n: number, label: string) => `Option ${n}: ${label}`,
      words: (text: string) => `In words: ${text}`,
      cites: "The lines it rests on (each checked: the quoted words are on that line)",
      accept: "Accept as my answer",
      accepting: "Accepting…",
      orAnswer: "Or answer it yourself below.",
      /** Seventh UX walk: AI proposes first; a person accepts or corrects each one. */
      askTitle: "Ask AI to propose answers",
      askWhy:
        "Your assistant reads the code and config behind each open question and proposes an answer with the lines it rests on. Atticus checks every line it cites and shows each proposal on its question; nothing is answered until you accept it or answer otherwise.",
      /** Ninth UX walk: when runtime.yaml's decide.questions is auto, say what happens instead. */
      askWhyAuto:
        "Your assistant reads the code and config behind each open question and proposes an answer with the lines it rests on. Atticus checks every line it cites. Each proposal for an option question that meets the bar (the code's shapes rank that option first, or a person's rule says the same) is applied as the AI's answer, marked Detected by AI, never as yours: correct any that is wrong. The rest wait on their questions for you to accept or answer otherwise.",
      askWhyPaused: (why: string) =>
        `AI deciding is paused (${why}), so each proposal waits on its question for you to accept or answer otherwise.`,
      askHandoff: "Hand it to my assistant",
      askHandingOff: "Handing it off…",
      askWaiting: (run: string) =>
        `Handed off as run ${run}. In a NEW Copilot Chat (agent mode) or Claude Code session at the metarepo, run the line below. When it has written its proposals, press Done: Atticus reads them in.`,
      askDone: "Done: read the proposals in",
      askReading: "Reading the proposals in…",
      askRead: "Read in.",
      askTerminal: "Or in a terminal:",
      askSlash: "In Copilot Chat or Claude Code, at the metarepo:",
      askCommand:
        "Or in a terminal (where runtime.yaml allows copilot-acp, it runs in a new Copilot session):",
      askCopy: "Copy",
      command: (id: string) => `atticus questions answer ${id} --accept-proposal`,
    },
    title: "Questions",
    intro:
      "When something isn't settled, Atticus asks here, and each question goes to the person whose role answers it. Your answer is saved with the question; then Apply uses it, and Propose for review sends it for review.",
    /** Eighth UX walk: Questions opened for one change (?change=) shows the questions its steps asked. */
    changeIntro: (id: string) =>
      `The questions ${id}'s steps asked. Your answer is written to the question's file in questions/; then the step that asked it runs again and reads it.`,
    onlyChange: (id: string) => `Only the questions ${id}'s steps asked.`,
    showAll: "Show every question",
    filter: "Show",
    filterOpen: "Open",
    filterAll: "All",
    listTitle: "Questions",
    // ADR 0191 (app-only audit): no word of scans: a change's steps ask here too.
    empty:
      "No question waits for an answer. When a step needs a person to settle something, it asks here.",
    emptyAll: "No questions yet. When a step needs a person to settle something, it asks here.",
    emptyChange: (change: string) => `No question for ${change} waits for an answer.`,
    emptyChangeAll: (change: string) => `No question for ${change} yet.`,
    unreadable: (file: string) => `${file} isn't a valid question file.`,
    pickFromList: "Pick a question from the list to answer it.",
    /** UX review (2026-11-08): the questions a step raised, or the knowledge gaps' owner questions. */
    kind: "Kind",
    kindSteps: (n?: number) => (n === undefined ? "From the steps" : `From the steps (${n})`),
    kindOwner: (n?: number) => (n === undefined ? "Owner questions" : `Owner questions (${n})`),
    ownerQuestions: {
      title: "Owner questions",
      intro:
        "An owner question asks a system's owner for a fact the code can't give. Ask the owner, then record what they said here: it is written to catalog/curated/ownerquestion/<id>.yaml, which every scan keeps. The gap itself closes once the fact is in the catalog.",
      empty: "No owner questions: the catalog has every fact its checks need.",
      emptyCatalog:
        "The catalog is empty, so nothing is asked yet. Read the repos first (Set up), and the owner questions appear here.",
      ask: (owner: string, system: string, channel: string) =>
        `Ask ${owner} · ${system} · by ${channel}`,
      routeTo: (role: string) => `Nobody owns it: it goes to the ${role}.`,
      needs: (fact: string) => `Needs: ${fact}`,
      fill: (file: string, field: string) => `The fact itself goes in org-pack/${file}: ${field}.`,
      open: "OPEN",
      answered: "ANSWERED",
      answeredWas: (answer: string) => `Recorded answer: ${answer}`,
      answerLabel: "The owner's answer",
      answerAgain: "Change the recorded answer",
      save: "Record the answer",
      saving: "Recording…",
      saved: (file: string) =>
        `Recorded in ${file}. The gap closes once the fact is in the catalog. Propose it for review below.`,
      needAnswer: "Write what the owner said first.",
      /** Ninth UX walk: a critic gap a person asked of its owner. */
      fromFinding: (change: string, gate: string, id: string) =>
        `Asked from ${change}'s ${gate} review (${id}): the hand-off waits for this answer.`,
      savedGap: (gate: string) =>
        `Recorded the answer as yours. The gap is closed at the ${gate} gate; the next draft reads the answer.`,
      command: (id: string) => `atticus questions owner ${id} --text "…"`,
      copyCommand: "Copy the command",
    },
    askedBy: (command: string, day: string) => `Asked by ${command} on ${day}`,
    /** Seventh UX walk: when a question was asked, in words, never the command that asked it. */
    askedWhen: {
      verify: (repo: string, day: string) => `Asked when Atticus checked ${repo}'s map on ${day}`,
      read: (repo: string, day: string) => `Asked when Atticus read ${repo} on ${day}`,
      stage: (stage: string, change: string, day: string) =>
        `Asked at the ${stage} stage of ${change} on ${day}`,
      step: (step: string, day: string) => `Asked by Atticus's ${step} step on ${day}`,
    },
    /** What an option changes, said for the app: Apply on this page writes the map. */
    whenApplied: (repo: string) => `when the answers are next applied to ${repo}'s map`,
    pickBelow:
      "pick this and the list of every repo, system and team opens below; it takes the one you name",
    /** The copy button beside a question's id on its card. */
    copyId: "Copy the id",
    counts: {
      label: (repo?: string) => (repo ? `Questions in ${repo}` : "Questions in the estate"),
      open: "Open",
      answered: "Answered",
      retired: "Retired",
      total: "All",
      progress: (pct: number) => `${pct}% settled`,
      repos: (n: number) => `${n} repo${n === 1 ? "" : "s"}`,
    },
    bulk: {
      pick: (id: string) => `Pick ${id} to answer with others`,
      pickRepo: (repo: string) => `Pick every open question in ${repo}`,
      title: (n: number) => `Answer ${n} question${n === 1 ? "" : "s"} the same way`,
      more: (n: number) => `and ${n} more`,
      how: "Answer with",
      byTarget: "Where the calls go",
      byWords: "Your own words",
      targetLabel: "Repo, system or team",
      hint: "Each picked question gets this answer for its own repo, as if answered one by one. A question it doesn't fit says why; the rest are still answered.",
      needTarget: "Name the repo, system or team the calls go to.",
      submit: (n: number) => `Answer ${n}`,
      busy: "Answering…",
      clear: "Clear the picks",
      done: (n: number) => `Answered ${n}.`,
      next: "atticus verify --all --write",
    },
    groupOf: (repo: string, n: number) => `${repo}: ${n} question${n === 1 ? "" : "s"}`,
    evidence: "What it read",
    notShown: "Not shown: the file isn't here, or the line is past its end.",
    excerptOf: (ref: string) => `The code at ${ref}`,
    options: "Your answer",
    optionChanges: "It would change",
    /** Seventh UX walk: an answered map question whose repo hasn't had Apply since. */
    notApplied: "This answer isn't in the map yet. Apply puts it there:",
    /** ADR 0188: applied, its file not proposed yet. */
    notProposed: "This answer is in the map, not proposed for review yet:",
    ownWords: "In my own words",
    ownWordsLabel: "Your answer, in your own words",
    // Beta.24 review: a question about where calls go takes words that name a repo or system.
    ownWordsJoin:
      "Name a repo, component or system Atticus knows. Words that name none are refused, never drawn as a box: for a new outside system, choose it from the list above; if these aren't real calls, choose Ignore.",
    ignore: {
      /**
       * Beta.25: the Ignore option's words, the same as the core's JOIN_IGNORE_LABEL (the answer's
       * value is read by them, so a test keeps the two the same).
       */
      label: "Ignore: not a real call (e.g. CI/CD, a test, a template)",
      means:
        "These aren't real calls: a CI/CD job, a test or a template, not code that runs. The join leaves them, no box is drawn for them, and this isn't asked again.",
      reason: "Why (optional)",
      answered: (by: string, day: string, reason?: string) =>
        `Ignored by ${by} on ${day}: not a real call${reason ? ` (${reason})` : ""}`,
    },
    scope: "Who the answer is for",
    scopeRepo: (repo: string) => `This repo only (${repo})`,
    scopeChange: (change: string) => `This change only (${change})`,
    scopeType: (type: string) => `Every repo of type ${type}`,
    scopeTypeOther: "Every repo of a type",
    typeLabel: "The repo type",
    proposed: "proposed",
    submit: "Save the answer",
    saving: "Saving",
    pickOne: "Pick one of the options, or answer in your own words.",
    needWords: "Write your answer, or pick one of the options.",
    needType: "Say which repo type the answer is for, or keep it to this repo.",
    saved: (file: string) => `Saved to ${file}.`,
    skillWritten: (path: string) => `Also written under Answers in ${path}.`,
    skillMissing: (path: string) =>
      `${path} isn't there yet, so the answer is kept in the question file, with that path.`,
    next: "Apply it to the map, then propose it for review.",
    nextStage: "Run the step it came from again, from here:",
    orCommandLine: "Or in a terminal:",
    copy: "Copy the command",
    answered: (by: string, day: string) => `Answered by ${by} on ${day}`,
    retired: "This question is retired; nothing reads its answer.",
    change: "Change the answer",
    // ADR 0140: asked in order, routed to the team that owns the repo.
    whose: "Whose",
    whoseAll: "Everyone's",
    whoseMine: "My teams'",
    owner: (team: string, name?: string) => `Owner: ${name ? `${name} (${team})` : team}`,
    noOwner: (why: string) => `No owner: ${why}`,
    /** Ninth UX walk: the role a question is for, on the list and the question. */
    forRole: (who: string) => `For ${who}`,
    restsOn: (changes: string[] | string) => {
      const list = typeof changes === "string" ? [changes] : changes;
      return `Ask first: ${list.join(", ")} ${list.length === 1 ? "rests" : "rest"} on it`;
    },
    joins: (n: number) => `Its answer joins ${n} ${n === 1 ? "call" : "calls"}`,
    mineTeams: (teams: string) => `Questions for your teams: ${teams}.`,
    mineNone: (handle: string) =>
      `${handle} is on no team in org-pack/roles.yaml, so no question is yours here. Add yourself under a team's people there (schemaVersion 2), or show everyone's.`,
    emptyMine: "No questions are waiting for your teams.",
    // ADR 0153 (Q4): a change's own questions go to the people its change.yaml names.
    changeOwner: (change: string, people: readonly string[] | string) =>
      `Owner: the people of ${change} (${(typeof people === "string" ? [people] : people).join(", ")})`,
    mineChanges: (handle: string) =>
      `Questions of the changes that name ${handle} under owners. ${handle} is on no team in org-pack/roles.yaml.`,
    // ADR 0153 (Q2): one answer covers every call a host pattern or a path prefix matches.
    rule: {
      label: "Answer by rule (optional)",
      hint: "A host pattern (*.payments.forge.internal) or a path prefix (/forge/limits/**): your answer then covers every call that matches, the calls found later too, in the repos the scope above allows.",
      answered: (match: string) => `By rule: every call matching ${match}`,
      // ADR 0168: several open questions share a path prefix or host: one answer covers them.
      offer: (n: number, calls: number, match: string) =>
        `Answer once for all ${n}: ${match} is filled in, so this answer covers the ${calls} calls of the ${n} open questions like this one, and the others retire on the next verify --write. Clear it to answer this one only.`,
      offerListed: (n: number, match: string) => `One answer covers all ${n}: ${match}`,
    },
    // ADR 0162 (F8): "Another repo…", the picker of the whole estate, and a reopened answer.
    another: {
      label: "Which repo, system or team",
      loading: "Loading the repos, systems and teams…",
      failed: (why: string) => `The list didn't load: ${why}`,
      empty: "The org pack lists no repos, systems or teams yet. Answer in your own words instead.",
      choose: "Choose one",
      repos: "Repos of the manifest",
      systems: "Systems of the profile",
      teams: "Teams in roles.yaml",
      notRead: "not read yet",
      noSystem: "no system yet",
      newVendor: "An outside system (new): its name",
      newVendorHint:
        "Leave the list on “Choose one” and type the system's name to add it to the profile: a short name (letters, digits, spaces and dashes, up to 40 characters), not a sentence. If these aren't real calls, choose Ignore instead.",
      pickOne: "Choose a repo, system or team, or type a new outside system's name.",
      addTeam: (team: string, system: string) =>
        `${team} has no system yet: add ${system} (another team's, owner ${team}) to the profile, as a file change for review in the pull request`,
      addVendor: (name: string) =>
        `Add ${name} to the profile as a vendor, as a file change for review in the pull request`,
      needAdd: "Tick the box to add the system to the profile, or choose one that is listed.",
      added: (id: string, profile: string) =>
        `Wrote the system ${id} into ${profile}; review it in the same pull request.`,
    },
    reopened: (why: string, answer: string, day: string) =>
      `Asked again on ${day}: you answered ${answer}, and ${why}`,
    // ADR 0153 (Q5): an answer accepted from the assistant's proposal says so.
    fromProposal: (by: string, day: string) =>
      `It was ${by}'s proposal (${day}), confirmed by the person who answered. It cited:`,
    /** Ninth UX walk: an AI answer's proposal was applied by Atticus as the AI's, never confirmed by a person. */
    fromAiProposal: (by: string, day: string, run: string) =>
      `${by} proposed it (${day}) and Atticus applied it as the AI's from run ${run}, because it met the bar. No person has confirmed it. It cited:`,
    changeAiAnswer:
      "To change the AI's answer, Correct it above: your answer is recorded as yours, and Apply to similar spreads it to the questions like it.",
  },
  /** Knowledge managed in the metarepo (ADR 0101), in the app (ADR 0102). */
  knowledge: {
    nav: {
      sources: "Knowledge sources",
      documents: "Documents",
      items: "Knowledge items",
      search: "Search the wikis",
      parties: "Teams, vendors and products",
      orgpack: "Org pack from the wikis",
    },
    emptyGo: "Open Knowledge sources to add or sync a wiki",
    /** ADR 0122: the files in the metarepo's inputs/, general knowledge. */
    documents: {
      title: "Documents",
      intro:
        "Files dropped in the metarepo's inputs/ are general knowledge: decisions, runbooks, specs, request forms and slides. Sync reads them into a snapshot, and your assistant reads that into knowledge items, each quote checked against the file. A file for one change only goes in that change's Files attached instead.",
      add: "Add files",
      adding: "Adding…",
      added: (n: number) =>
        `Added ${n} file${n === 1 ? "" : "s"} to inputs/inbox/. Commit them through a pull request.`,
      sync: "Sync inputs/",
      syncing: "Syncing…",
      syncedNow: "inputs/ is read into a new snapshot. Your assistant reads it into items next.",
      listTitle: "Files in inputs/",
      empty: "Nothing in inputs/ yet. Add files here, or run atticus intake add <files>.",
      neverSynced: "Not synced yet: Sync reads what can be read into a snapshot.",
      synced: (date: string, read: number, all: number) =>
        `Snapshot of ${date}: ${read} of ${all} file${all === 1 ? "" : "s"} read.`,
      kindLabel: "Kind",
      anyKind: "Any kind",
      systemLabel: "System",
      anySystem: "Any system",
      filtered: "documents",
      kinds: {
        document: "Document",
        spreadsheet: "Spreadsheet",
        diagram: "Diagram",
        image: "Picture",
        openapi: "OpenAPI spec",
        swagger: "Swagger spec",
        asyncapi: "AsyncAPI spec",
        protobuf: "Protobuf spec",
        avro: "Avro schema",
        payload: "Payload sample",
        "ticket-export": "Ticket export",
        unknown: "Unknown",
      } as Record<string, string>,
      states: { read: "Read", skipped: "Not read", "not-synced": "Not synced yet" } as Record<
        string,
        string
      >,
      inbox: "In the inbox",
      systems: (list: string) => `About ${list}`,
      noSystems: "Names no system",
      age: (days: number) =>
        days === 0 ? "changed today" : `changed ${days} day${days === 1 ? "" : "s"} ago`,
      items: (n: number, verified: number) =>
        `${n} knowledge item${n === 1 ? "" : "s"}, ${verified} verified`,
      verified: "verified",
      why: (reason: string) => `Not read: ${reason}.`,
      newer: (path: string) => `A newer version is ${path}.`,
      duplicate: (path: string) => `The same file as ${path}.`,
      readTitle: "Read them into knowledge items",
      readWhy:
        "Your assistant reads the snapshot of inputs/ into patterns, standards, processes, requests, decisions and constraints. Atticus checks every quote against the file.",
    },
    kinds: {
      pattern: "Pattern",
      standard: "Standard",
      process: "Process",
      request: "Request",
      decision: "Decision",
      constraint: "Constraint",
      team: "Team",
      vendor: "Vendor",
      product: "Product",
      project: "Project",
    } as Record<string, string>,
    /** The groups needs.md and the items list use. */
    groups: [
      { title: "Requests and processes", kinds: ["request", "process"] },
      { title: "Standards and patterns", kinds: ["standard", "pattern"] },
      { title: "Decisions and constraints", kinds: ["decision", "constraint"] },
      { title: "Teams and vendors", kinds: ["team", "vendor"] },
      { title: "Products and projects", kinds: ["product", "project"] },
    ],
    fields: {
      title: "Title",
      name: "Name",
      appliesWhen: "Applies when",
      leadTime: "Lead time",
      handledBy: "Handled by",
      catalogueItem: "Catalogue item",
      inputs: "It needs",
      steps: "Steps",
      notes: "Notes",
      definition: "Definition",
      rules: "Rules",
      reason: "Reason",
      owner: "Owner",
      responsibilities: "Responsibilities",
      owns: "Owns",
      uses: "Uses",
      contacts: "Contacts",
      channel: "Channel",
      aliases: "Also called",
      description: "What it is",
      ownedBy: "Owned by",
      usedBy: "Used by",
      vendor: "Vendor",
      systems: "Systems",
      urls: "Links",
      decision: "Decision",
      stance: "Stance",
    } as Record<string, string>,
    review: {
      verified: (by: string, day: string) => `✓ Verified by ${by} on ${day}`,
      corrected: (by: string, day: string) => `✓ Corrected by ${by} on ${day}`,
      rejected: (by: string, day: string) => `✗ Rejected by ${by} on ${day}`,
      stale: (by: string) => `Check again: its page changed since ${by} reviewed it`,
      staleRejected: (by: string, day: string) =>
        `✗ Rejected by ${by} on ${day}, then its page changed: still left out until checked again`,
      staleCorrected: (by: string, fields: string) =>
        `Check again: ${by} corrected ${fields} before its page changed; the correction isn't used until checked again`,
      none: "Not yet verified: check it against its page",
      because: "Why",
      correctedFields: (f: string) => `Corrected: ${f}`,
    },
    ai: {
      intro: "This step needs a model. Run the command in a terminal at the metarepo:",
      introOr: "Or run the command in a terminal at the metarepo:",
      slash: "Or type this in Copilot Chat or Claude Code:",
      copy: "Copy the command",
      copySlash: "Copy the slash command",
    },
    sources: {
      intro:
        "The wikis and docs repos in org-pack/sources.yaml. Sync copies a source's pages to a dated snapshot; the knowledge scan then reads the snapshot with your assistant, and every quote is checked.",
      listTitle: "Sources",
      empty: "No wiki is in sources.yaml yet. Add one below.",
      type: "Type",
      location: "Where",
      ref: "Branch or tag",
      path: "Folder of its pages",
      checkout: "Checkout",
      owner: "Owner",
      tags: "Tags",
      noTags: "No tags: it is read for every kind",
      /** ADR 0132: how much a source's word counts, and where it applies. */
      authority: "Authority",
      authorities: {
        standard: "Standard: the organisation's own rules",
        platform: "Platform: a shared platform team's guidance",
        framework: "Framework: a framework's own documentation",
        team: "Team: a team's pages",
        reference: "Reference: glossaries and notes",
      } as Record<string, string>,
      noAuthority: "Not set: it ranks as a team's pages",
      byPage: (n: number) => `${n} page override${n === 1 ? "" : "s"} in sources.yaml`,
      scope: "Applies to",
      everywhere: "Every task: no appliesTo in sources.yaml",
      restricted: "Restricted pages",
      readsRestricted: "Read: the metarepo's audience may read them",
      skipsRestricted: "Skipped, path and reason only",
      maxPages: (n: number) => `A scan reads at most ${n} page${n === 1 ? "" : "s"} of it a run`,
      snapshot: "Newest snapshot",
      noSnapshot: "Never synced",
      snapshotLine: (date: string, pages: number, days: number) =>
        `${date}: ${pages} page${pages === 1 ? "" : "s"}, ${days} day${days === 1 ? "" : "s"} old`,
      commit: (c: string) => `at commit ${c.slice(0, 7)}`,
      scanned: (date: string) => `The knowledge scan read the snapshot of ${date}`,
      notScanned: "The knowledge scan hasn't read it yet",
      stale: (days: number) => `Sync it again: the snapshot is older than ${days} days`,
      unsynced: "Not synced yet: sync it so the knowledge scan can read it",
      sync: (id: string) => `Sync ${id}`,
      syncing: "Syncing",
      synced: (id: string) => `Synced ${id}.`,
      scanLabel: "Knowledge scan",
      addTitle: "Add a source",
      addIntro:
        "Atticus checks the wiki and writes its entry into org-pack/sources.yaml, keeping the file's comments. Commit the file through a pull request: merging it is the approval.",
      addType: "Type of wiki",
      addLocation: "Location: a URL, or a folder relative to the metarepo",
      addId: "Id (optional; made from the location when empty)",
      addPath: "Folder of its pages (git only)",
      addRef: "Branch or tag (git only; default the repository's default branch)",
      addSubmodule: "Keep it as a submodule of the metarepo (git only)",
      addKinds: "Kinds of knowledge it holds, comma-separated",
      addFrameworks: "Frameworks it is about, comma-separated",
      addOwner: "Owner",
      addSave: "Write it into sources.yaml (otherwise only show the entry)",
      add: "Add the source",
      adding: "Adding",
      needLocation: "Say where the wiki is.",
      gitOnly: "Branch, folder and submodule are for a git wiki.",
      notSlug: (v: string) => `${v} isn't a tag: use lowercase letters, digits and dashes.`,
      problems: "These files don't read:",
    },
    scan: {
      title: "What the last scan changed",
      never: "No knowledge scan has run yet.",
      at: (day: string) => `Scanned on ${day}`,
      added: "New",
      changed: "Changed",
      removed: "Gone",
      nothing: "The last scan changed no item.",
      flags: (c: number, i: number, f: number) =>
        `${c} conflict${c === 1 ? "" : "s"} between pages, ${i} quarantined text${i === 1 ? "" : "s"}, ${f} item${f === 1 ? "" : "s"} that failed the checks`,
      checkAgain: "Reviews to check again",
      noCheckAgain: "No review waits to be checked again.",
      rescan: "Read every source again (only changed pages go to your assistant):",
    },
    items: {
      intro:
        "What the knowledge scan read from the wikis, as people reviewed it. A tick lasts until the page under it changes; a rejected item is left out of plans and answers, and still listed here with its reason.",
      kind: "Kind",
      allKinds: "All kinds",
      empty:
        "There are no knowledge items yet. Sync a source on the Knowledge sources page, then read it with your assistant.",
      noMatch: "No item matches.",
      pick: "Pick an item to see it and review it.",
      reviewStart: (n: number) =>
        n ? `Review what no one has checked (${n})` : "Nothing waits for a review",
      reviewStop: "Stop reviewing",
      reviewKeys: (n: number) =>
        `Review mode, ${n} waiting: j or ↓ next, k or ↑ back, v verify and go on, c correct, r reject.`,
      missing: (id: string) =>
        `There is no knowledge item ${id}: a rescan may have removed it, or the link is wrong. Pick one from the list.`,
      count: (n: number) => `${n} item${n === 1 ? "" : "s"}`,
      quote: "What the page says",
      page: (where: string, line?: number) => `${where}${line ? `, line ${line}` : ""}`,
      links: "Links",
      noLinks: "The page gives no link for it.",
      conflict: "Another page disagrees with it: see the conflicts in knowledge/scan.yaml.",
      verify: "Verify",
      correct: "Correct",
      reject: "Reject",
      cancel: "Cancel",
      save: "Save the correction",
      saving: "Saving",
      rejectWhy: "Why is it wrong? The next person reads it.",
      rejectSave: "Reject it",
      needWhy: "Say why it is wrong.",
      noChange: "Change a field first, or cancel.",
      verified: (id: string) => `Verified ${id}. Commit knowledge/reviews/ through a pull request.`,
      corrected: (id: string) =>
        `Corrected ${id}. Everything that reads it uses the correction from now on.`,
      rejected: (id: string) => `Rejected ${id}: plans and answers leave it out.`,
      correctIntro:
        "Only the fields a person may correct are here. What the page quoted can't be corrected: a quote is checked word for word.",
      addValue: "Add one",
      remove: "Remove",
      linkLabel: "Label",
      linkUrl: "Address (https://…)",
      badUrl: (u: string) => `${u} isn't an http(s) address.`,
      item: (n: number) => `Item ${n}`,
      link: (n: number) => `Link ${n}`,
      open: "Open the item",
    },
    search: {
      intro:
        "Look for a term or phrase across every wiki. The plain search runs here and shows the pages and sections that mention it. Your assistant then reads only those pages and proposes what they hold about it; every quote is checked.",
      label: "A term or phrase",
      placeholder: "e.g. new starter, Kafka topic, change freeze",
      go: "Search",
      needText: "Type a word or phrase to look for first.",
      searching: "Searching the wikis again…",
      noSnapshot: "No source has a snapshot yet: sync one on the Knowledge sources page first.",
      none: (q: string) =>
        `No page of the wikis mentions "${q}". There is nothing to send to your assistant.`,
      found: (n: number, pages: number) =>
        `${n} section${n === 1 ? "" : "s"} on ${pages} page${pages === 1 ? "" : "s"} mention it.`,
      next: "Have your assistant read those pages:",
      savedTitle: "Saved searches",
      noSaved: "No search has been saved yet. Each search your assistant runs is saved here.",
      candidates: (n: number, kept: number) => `${n} found, ${kept} kept`,
      fresh: "New",
      known: (id: string) => `Already known as ${id}`,
      kept: (as: string, by: string) => `Kept as a ${as} by ${by}`,
      keepAs: "Keep as",
      keep: "Keep",
      keeping: "Keeping",
      keepOf: (title: string) => `Keep ${title}`,
      keptNote: (id: string, as: string) =>
        `Kept ${id} as a ${as}, verified by you. Commit knowledge/items/ and reviews/ through a pull request.`,
      pick: "Pick a saved search to see what it found.",
    },
    parties: {
      intro:
        "The teams, vendors, products and projects the wikis name: what each team owns and uses, who owns each product, and the other names people use for them.",
      empty:
        "No team, vendor or product has been read from the wikis yet. The knowledge scan reads them.",
      teams: "Teams",
      vendors: "Vendors",
      products: "Products and projects",
      owns: "Owns",
      uses: "Uses",
      usedBy: "Used by",
      ownedBy: "Owned by",
      aliases: "Also called",
      responsibilities: "Responsible for",
      none: "None named",
      review: "Review it on the Knowledge items page",
    },
    orgpack: {
      intro:
        "The products and vendors the wikis name, drafted as each platform profile's systems. Accept the ones you pick: Atticus writes them into profile.yaml, keeping its comments, and you commit it through a pull request.",
      empty: "The org pack has no platform profile yet.",
      noDraft: "No draft yet for this platform.",
      draft: "Draft from the wikis",
      drafting: "Drafting",
      drafted: (n: number) => `Drafted ${n} system${n === 1 ? "" : "s"}.`,
      nothing: "The profile already has every system the knowledge items name.",
      add: "Add",
      update: "Update",
      gains: (what: string) => `gains ${what}`,
      verified: (by: string) => `✓ Verified by ${by}`,
      unverified: "Not yet verified: check it against its page",
      accept: "Accept the picked systems",
      accepting: "Accepting",
      pickOne: "Pick at least one system.",
      accepted: (added: number, updated: number, file: string) =>
        `Added ${added} and updated ${updated} in ${file}. Commit it through a pull request: merging it is the approval.`,
      pick: (name: string) => `Accept ${name}`,
      at: (day: string) => `Drafted on ${day}`,
      command: "Or in a terminal:",
    },
    needs: {
      title: "What this change needs",
      intro:
        "What the organisation needs from this change, from the knowledge items: requests to raise, standards to follow, decisions to keep to, teams to involve. Atticus never raises one: you do, then mark it here.",
      none: (id: string) =>
        `${id} has no needs list yet. Find what it needs early: a request's lead time runs from the day it is raised.`,
      empty: "Nothing in the knowledge items applies to this change.",
      groups: [
        { title: "Requests and processes to raise", kinds: ["request", "process"] },
        { title: "Standards and patterns to follow", kinds: ["standard", "pattern"] },
        { title: "Decisions and constraints that apply", kinds: ["decision", "constraint"] },
        {
          title: "Teams, vendors and products to involve",
          kinds: ["team", "vendor", "product", "project"],
        },
      ],
      for: (t: string) => (t === "change" ? "the whole change" : t.replace(":", " ")),
      leadTime: "Lead time",
      handledBy: "Handled by",
      catalogueItem: "Catalogue item",
      inputs: "It needs",
      steps: "How",
      rules: "Rules",
      links: "Links",
      why: "Why",
      when: (w: string) => `Needed ${w.replace("-", " ")}`,
      from: (p: string) => `From ${p}`,
      fromStories: "Suggested by the stories stage",
      open: "Open",
      done: (by: string, note?: string) => `Done by ${by}${note ? `: ${note}` : ""}`,
      notNeeded: (by: string, note: string) => `Not needed (${by}): ${note}`,
      markDone: "Done",
      markDoneOf: (title: string) => `Done: ${title}`,
      markSkipOf: (title: string) => `Not needed: ${title}`,
      reopenOf: (title: string) => `Reopen: ${title}`,
      openAgain: "open again",
      markSkip: "Not needed",
      reopen: "Reopen",
      doneNote: "Note (optional), e.g. the CTASK number",
      skipNote: "Why it isn't needed (a reviewer reads it)",
      save: "Save",
      cancel: "Cancel",
      needWhy: "Say why it isn't needed.",
      marked: (title: string, status: string) =>
        `${title} is ${status}. Commit needs.yaml with the change.`,
      considered: "Considered and left out",
      openCount: (n: number) => `${n} open`,
    },
  },
  /** The menu: six entries (the Surfaces design), then More pages with every other page. */
  nav: {
    main: "Main",
    /** The Overview's name: it is part of Home now, and Ctrl+K finds Home by it. */
    dashboard: "Overview",
    onboarding: "Onboarding",
    feature: "Feature design",
    architecture: "Architecture",
    stories: "Stories",
    tasks: "Tasks",
    knowledge: "Knowledge",
    /** The six entries, by their id in screens.ts, and Atticus's own pages (under More pages). */
    sections: {
      Home: "Home",
      Map: "Map",
      Change: "Change",
      Questions: "Questions",
      Knowledge: "Knowledge",
      SetUp: "Set up",
      Atticus: "Atticus",
    },
    /** The phases a change's pages are grouped by. */
    groups: {
      Define: "Define",
      Design: "Design",
      Plan: "Plan",
      Build: "Build",
      Release: "Release",
    },
    /** The tabs of a section, and where you are. */
    tabs: (section: string) => `${section} pages`,
    youAreHere: "You are here",
    /** The pages, by screen id. */
    screens: {
      home: "Home",
      canvas: "Estate canvas",
      trust: "Trust",
      explore: "Search the catalog",
      map: "Ecosystem map",
      impact: "Impact explorer",
      features: "Features",
      orgpack: "Org pack",
      intake: "Intake",
      scans: "Scans",
      brief: "Brief",
      ux: "Prototypes and UX",
      archReview: "Architecture review",
      diagrams: "Diagrams",
      reconcile: "Reconcile",
      contracts: "Contracts",
      mappings: "API mappings",
      breakdown: "Breakdown",
      initiatives: "Initiatives",
      changes: "All changes",
      tasks: "Task board",
      trace: "Test trace",
      todo: "Manual steps",
      release: "Release plan",
      serviceDesk: "Service desk queue",
      governance: "Governance",
      evals: "AI quality",
      learning: "Learning",
      settings: "Settings",
      ai: "AI",
      repos: "Repos",
      cockpit: "At a glance",
      systems: "Systems",
      outside: "Outside systems",
      mismatches: "Mismatches",
      runs: "Model runs",
      history: "Prompt history",
      words: "What the words mean",
      changeDiagram: "Change diagram",
      estimate: "Estimate",
      conformance: "Code against design",
      /** A change's knowledge (2026-10-27): its own page, beside Feature design. */
      changeKnowledge: "Knowledge",
      /** ADR 0181: what the AI decided, its batches and Undo. */
      decisions: "Decided by AI",
      /** ADR 0195 (CS3): the readers' cross-check, and the catalog's builds. */
      crosscheck: "Readers found / facts say",
      catalogBuilds: "Catalog builds",
    },
  },
  /**
   * ADR 0195 (ticket CS3): the readers' cross-check (Map › Trust › Readers found / facts say) and
   * the catalog build's confirm steps (Set up › Scans › Catalog builds): a refused build's
   * removals and hand edits, undo of the last five builds, and prune.
   */
  crossCheck: {
    title: "Readers found / facts say",
    intro:
      "For each repo with verified facts, what the built-in readers found is compared with what the facts say. The facts are the map; the readers are a cross-check. Nothing here changes the catalog: check the cited line, then dismiss what the readers got wrong, or ask your assistant to read the repo again.",
    openFromTrust: "Readers found / facts say",
    openFromTrustOf: (repo: string) => `Readers found / facts say for ${repo}`,
    crossCheckLine: (found: number, disagree: number) =>
      `Readers' cross-check: ${found} found by the readers only, ${disagree} disagree.`,
    repoPicker: "Repo",
    empty:
      "No repo has verified facts yet, so there is nothing to check the readers against. Read a repo with your assistant and Apply it on Map › Trust; then scan to compare.",
    loadingRepo: "Loading the cross-check",
    state: {
      compared: "Compared",
      "no-facts":
        "No facts yet: its map comes from the built-in readers, so there is nothing to compare.",
      "no-readers":
        "No readers slot yet: check this repo with the built-in readers (Set up › Scans) to compare.",
      legacy:
        "Kept from before the upgrade, not yet read by the built-in readers: scan or verify this repo to replace it.",
      unusable: "A slot doesn't read, so it isn't compared.",
    } as Record<string, string>,
    commits: (readers: string, facts: string) =>
      `Readers read commit ${readers}; the facts are of commit ${facts}.`,
    behind: (head: string) =>
      `The base clone is at ${head} now: a slot behind it is shown as read at its own commit.`,
    counts: (found: number, disagree: number, factsOnly: number, agree: number) =>
      `${found} found by the readers only · ${disagree} disagree · ${factsOnly} in the facts only · ${agree} agree`,
    filterLabel: "Show",
    filter: {
      "readers-only": (n: number) => `Readers found (${n})`,
      disagree: (n: number) => `Disagree (${n})`,
      "facts-only": (n: number) => `Facts only (${n})`,
      dismissed: (n: number) => `Dismissed (${n})`,
      all: (n: number) => `All (${n})`,
    } as Record<string, (n: number) => string>,
    kindLabel: "Kind",
    allKinds: "Every kind",
    searchLabel: "Find",
    searchHint: "A key, an id or a file",
    shown: (n: number, of: number) => `${n} of ${of} shown`,
    noneShown: "Nothing matches these filters.",
    allAgree: "The readers and the facts agree on everything they both have.",
    listLabel: (repo: string) => `Cross-check items of ${repo}`,
    itemState: {
      "readers-only": "Readers found",
      disagree: "Disagree",
      "facts-only": "Facts only",
    } as Record<string, string>,
    readersSay: "Readers",
    factsSay: "Facts",
    nothing: "nothing",
    field: "Field",
    fieldsCaption: (key: string) => `What the readers and the facts say of ${key}`,
    factsOnlyNote: "For information: the built-in readers are known to miss things.",
    dismissed: "Dismissed",
    dismiss: "Dismiss",
    dismissOf: (key: string) => `Dismiss ${key}`,
    dismissHint:
      "Check the cited line first. A dismissal is kept in facts/<repo>.crosscheck.yaml at the readers' value, and the item is listed again if that value changes.",
    undismiss: "List again",
    undismissOf: (key: string) => `List ${key} again`,
    working: "Writing…",
    dismissedNote: (key: string) => `Dismissed ${key}.`,
    undismissedNote: (key: string) => `${key} is listed again.`,
    failed: (why: string) => `Nothing written: ${why}`,
    proposeHint: "The dismissals file is yours to propose for review, like any edit.",
    problems: "Files that couldn't be read",
  },
  catalogBuild: {
    title: "Catalog builds",
    intro:
      "catalog/generated is built from each repo's source slot (its verified facts, else its built-in readers' last full read) and the curated decisions. Nothing is removed or overwritten without being shown first, and every build can be undone.",
    openFromScans: "Catalog builds: confirm, undo, prune",
    sourcesTitle: "Where each repo's records come from",
    sourcesCaption: "Each repo's source in the build",
    col: { repo: "Repo", source: "Source", commit: "Commit", note: "Note" },
    source: {
      facts: "Verified facts",
      readers: "Built-in readers",
      legacy: "Kept from before the upgrade",
      none: "No slot yet",
    } as Record<string, string>,
    noSources: "The manifests list no repo yet.",
    pendingTitle: "The next build",
    upToDate: "catalog/generated is what the slots and inputs build. Nothing waits.",
    wouldWrite: (n: number) =>
      `A build would write the slots' changes, removing ${n} ${n === 1 ? "record" : "records"} (within the limits).`,
    wouldWriteNothing: "A build would write the slots' changes; nothing would be removed.",
    build: "Build now",
    building: "Building…",
    refusedTitle: "The build waits for you: nothing has been written.",
    reason: {
      "large-removals": (n: number) =>
        `It would remove ${n} ${n === 1 ? "record" : "records"}, more than 10% of a repo's or 200 in one build.`,
      "hand-edits": (n: number) =>
        `${n} ${n === 1 ? "file" : "files"} under catalog/generated ${n === 1 ? "was" : "were"} changed by hand since the last build.`,
      "unexplained-removals": (n: number) =>
        `It would remove ${n} ${n === 1 ? "record" : "records"} that no changed slot or input explains. That is a bug: nothing can confirm it. The list is its report.`,
      "not-upgraded": (n: number) =>
        `This catalog was written before beta.27 (${n} record files): upgrade the metarepo first, which shows what it would do.`,
      empty: () =>
        "The build has no record from any repo's code, so the catalog is left as it was.",
      "nothing-read": () => "The scan read no repo in full, so it wrote nothing.",
    } as Record<string, (n: number) => string>,
    inTerminal: "In a terminal",
    reviewRemovals: (n: number) => `Review the ${n} removals`,
    removalsTitle: (n: number) => `Confirm ${n} ${n === 1 ? "removal" : "removals"}`,
    removalsIntro:
      "These records are in the catalog now and the build would remove them. Each says what explains it. Nothing is removed until you confirm, and undo takes it back.",
    removalsCaption: "The records the build would remove",
    removalCol: { record: "Record", repos: "Repos", why: "Explained by" },
    noRepo: "no repo",
    typeCount: (n: number) => `Type ${n} to confirm exactly these`,
    countHint: "A confirmation names the count it was shown, so it never covers more.",
    countWrong: (n: number) => `Type ${n}, the number listed.`,
    confirmRemove: (n: number) => `Remove ${n} ${n === 1 ? "record" : "records"}`,
    cancel: "Cancel",
    editsTitle: "Hand edits",
    editsIntro:
      "These files were changed by hand since the last build. A build never overwrites them: make each a curated decision, which every later build keeps, or discard them (a copy is kept for undo).",
    editsCaption: "Files changed by hand",
    how: { changed: "changed", added: "added", deleted: "deleted" } as Record<string, string>,
    curate: (n: number) => `Make ${n === 1 ? "it" : `these ${n}`} curated`,
    curating: "Making them curated…",
    curateHint:
      "Writes a curated decision for each into catalog/curated/, to propose for review, then builds.",
    discard: (n: number) => `Discard ${n === 1 ? "it" : `these ${n}`}…`,
    discardTitle: (n: number) => `Discard ${n} hand ${n === 1 ? "edit" : "edits"}`,
    discardIntro:
      "The build replaces these files with what the slots build. Their bytes are kept in the undo copy first.",
    confirmDiscard: (n: number) => `Discard ${n} ${n === 1 ? "edit" : "edits"}`,
    upgradeTodo: "Upgrade the metarepo on Set up › Settings, or in a terminal:",
    lastTitle: "The last build here",
    lastNone: "No build has been written on this machine yet.",
    lastLine: (command: string, at: string) => `${command}, ${at}`,
    lastCounts: (added: number, changed: number, removed: number) =>
      `${added} added · ${changed} changed · ${removed} removed`,
    lastSlots: (n: number) => `${n} slot ${n === 1 ? "file" : "files"} written`,
    lastRemoved: (n: number) => `The ${n} ${n === 1 ? "record" : "records"} it removed`,
    undoTitle: "Undo",
    undoIntro:
      "The last five builds on this machine keep an undo copy. Undo puts back catalog/generated, build.json and the slots as they were before a build, and can itself be undone. Git keeps everything older.",
    undoNone: "Nothing to undo: no build has been written here yet.",
    undoCaption: "The undo copies, newest first",
    undoCol: { n: "Copy", command: "Command", at: "When", files: "Files", act: "Undo" },
    undoTo: "Undo to before this…",
    undoToOf: (n: number) => `Undo to before copy ${n}`,
    undoPlanTitle: (n: number) => `Undo to before copy ${n}`,
    undoPlanIntro: (copies: string) => `Takes back: ${copies}.`,
    undoPlanCaption: "The files undo puts back",
    restore: "restore",
    remove: "remove",
    confirmUndo: (n: number) => `Put back ${n} ${n === 1 ? "file" : "files"}`,
    pruneTitle: "Prune",
    pruneIntro:
      "Slot files no build reads: repos no longer in the manifests or archived, and the upgrade's copy of the catalog. They are kept until you remove them.",
    pruneNone: "Nothing to prune: every slot file is one a build reads.",
    pruneCaption: "The files prune would remove",
    pruneReview: (n: number) => `Remove these ${n} ${n === 1 ? "file" : "files"}…`,
    pruneConfirmTitle: (n: number) => `Remove ${n} ${n === 1 ? "file" : "files"}`,
    pruneConfirmIntro: "Undo and git keep them.",
    confirmPrune: (n: number) => `Remove ${n} ${n === 1 ? "file" : "files"}`,
    done: "Done. What it printed is in the Console.",
    failed: (why: string) => `It stopped: ${why}`,
    problems: "Problems the build reported",
    orphaned: (repo: string, why: string) =>
      `${repo}: ${why === "archived" ? "archived" : "no longer in the manifests"}; its slots are kept, not built from.`,
  },
  /** Set up › Scans (ADR 0195): each repo's outcome of the last scan run here. */
  scanSources: {
    title: "What the scan read",
    caption: "Each repo's outcome of the scan",
    col: { repo: "Repo", outcome: "Readers slot", source: "Catalog from", note: "Why" },
    slot: {
      written: "Read in full",
      unchanged: "Read in full, unchanged",
      "kept-last-good": "Kept its last good read",
      none: "No read yet",
    } as Record<string, string>,
    at: (commit: string) => `at ${commit}`,
    why: {
      "not-cloned": "it isn't cloned here",
      unreadable: "its clone can't be read",
      "not-asked": "left out of this scan",
      "run-failed": "a reader run failed",
      "plugin-refused": "a plugin that applies to it isn't used",
      "readers-off": "the readers are switched off",
      dirty: "its clone has changes not committed",
      refused: "the scan wrote nothing",
      "dry-run": "a dry run writes nothing",
    } as Record<string, string>,
    factsStale: "its facts cite files changed since: read it again on Map › Trust",
    refusedBuild: "The scan read these repos, and its build waits for you:",
    confirmScan: (n: number) => `Scan again, removing ${n} ${n === 1 ? "record" : "records"}`,
    links: "Readers found / facts say, and the catalog's builds:",
  },
  /** Map › Trust (ADR 0124): how far to trust each repo's map, from the verifier's report. */
  trust: {
    // ADR 0164: the contract check's counts, with the way to the Mismatches page.
    contracts: (m: number, u: number, links: number) =>
      `Contracts: ${m} mismatch${m === 1 ? "" : "es"} and ${u} unconfirmed on ${links} link${links === 1 ? "" : "s"} with a payload on both sides.`,
    contractsOpen: "Open Mismatches",
    intro:
      "How far to trust each repo's map. Your assistant reads a repo and writes facts, each citing a file and line; the verifier keeps the facts whose line says what they claim and rejects the rest. Here is what it kept and rejected, how much of the code the facts cover, whether they are of the commit the checkout is at, and whether the catalog is built from them or from the built-in readers.",
    empty:
      "No repo is listed yet. Add your repos in Set up › Repos, then have your assistant read one with /atticus-map <repo>.",
    reportIn: (dir: string) => `The verifier's reports are in ${dir}/.`,
    summary: (trusted: number, all: number) => `${trusted} of ${all} repos trusted`,
    states: {
      "not-read": "Not read yet",
      unverified: "Not verified",
      rejected: "Facts rejected",
      stale: "Facts of another commit",
      unwritten: "Verified, not in the catalog",
      "unknown-files": "Files not read yet",
      trusted: "Trusted",
    } as Record<string, string>,
    why: {
      notRead:
        "Your assistant hasn't read this repo yet, so any map of it comes from the built-in readers.",
      unverified: "Its facts haven't been checked by the verifier yet.",
      rejected: (n: number) =>
        `The verifier rejected ${n} fact${n === 1 ? "" : "s"}: the cited line doesn't say what the fact claims. Fix ${n === 1 ? "it" : "them"} and verify again.`,
      stale: (facts: string, checkout: string) =>
        `The facts are of commit ${facts.slice(0, 7)}, but the checkout is at ${checkout.slice(0, 7)}. Read the repo again.`,
      unwritten: "Its facts are verified, but the catalog isn't built from them yet.",
      unknownFiles: (n: number, repo: string) =>
        `${n} source file${n === 1 ? " has" : "s have"} no fact citing ${n === 1 ? "it" : "them"} yet: read ${n === 1 ? "it" : "them"}, or exclude generated code in org-pack/scan/${repo}.yaml.`,
      trusted:
        "Every fact is verified at the checkout's commit, every source file is read, and the catalog is built from the facts.",
    },
    /** ADR 0148 (P3): what a person's sample audit of the repo found, with how small it is. */
    audit: "Sample audit",
    auditNone: (repo: string) => `None yet: atticus verify audit ${repo}`,
    auditTally: (
      what: string,
      t: {
        right: number;
        wrong: number;
        precision: number | null;
        low: number | null;
        high: number | null;
      },
    ) =>
      t.precision === null
        ? `${what}: no answers yet`
        : `${what}: ${Math.round(t.precision * 100)}% right (${t.right} of ${t.right + t.wrong}; 95% between ${Math.round((t.low ?? 0) * 100)}% and ${Math.round((t.high ?? 0) * 100)}%)`,
    auditFacts: "facts",
    auditLinks: "links",
    auditSmall: "A small sample: read the range, not the number.",
    /** ADR 0149 (P3's follow-up): drawing and answering the sample audit here. */
    sample: {
      open: "Answer a sample",
      openOf: (repo: string) => `Answer a sample audit of ${repo}`,
      intro:
        "A random sample of the repo's kept facts and the links the join makes from it, drawn as atticus verify audit draws it: the same seed draws the same sample on any machine. Read each item's lines and say whether it is right. Your answers go to the repo's audit file, a person's record you commit in a pull request; nothing is sent anywhere.",
      seed: "Seed",
      seedHint: (seed: string) => `Leave it empty for ${seed}, the repo at its facts' commit.`,
      seedHintNone: "Leave it empty for the repo at its facts' commit.",
      size: "How many facts and how many links",
      draw: "Draw",
      loading: "Drawing the sample…",
      failed: (why: string) => `Couldn't draw the sample: ${why}`,
      refused: {
        "no-facts": (repo: string) =>
          `${repo} has no facts to audit yet. Have your assistant read it (/atticus-map ${repo}), then run atticus verify ${repo}.`,
        "bad-facts": (repo: string) =>
          `${repo}'s facts file doesn't read as facts: run atticus verify ${repo} first.`,
        unverified: (repo: string, n: number) =>
          `${n} of ${repo}'s facts aren't verified yet, and an audit samples kept facts only. Run atticus verify ${repo} first.`,
        "bad-file": (repo: string) =>
          `${repo}'s audit file isn't one Atticus can read: atticus verify audit ${repo} --report says why.`,
      } as Record<string, (repo: string, n: number) => string>,
      empty: "Nothing to sample: the repo has no kept facts a reader wrote and no links.",
      item: (k: number, n: number, what: string, claim: string) => `${k} of ${n}: ${what} ${claim}`,
      fact: "fact",
      link: (how: string) => `link (${how})`,
      lines: "The lines it rests on",
      noText: "(the line isn't in the checkout)",
      choices: { right: "Right", wrong: "Wrong", unsure: "Unsure" } as Record<string, string>,
      note: "Note (what is wrong with it)",
      noteOptional: "Note (optional)",
      onFile: (answer: string, by: string) => `On file: ${answer}, by ${by}`,
      save: "Save the answers",
      saving: "Writing the answers…",
      nothingPicked: "Answer at least one item first.",
      saved: (file: string, answered: number, open: number) =>
        `Written to ${file}: ${answered} answered, ${open} open. Propose it for review, or commit it yourself:`,
      copyCommit: "Copy the git command",
      sameInTerminal: "The same draw in a terminal:",
      copyCommand: "Copy the audit command",
      wrongFact: "Correct this fact",
      wrongFactOf: (claim: string) => `Correct the fact ${claim}`,
      wrongLink: (repo: string) =>
        `Open ${repo} on the estate canvas, then the link's Why is this linked? › This link is wrong`,
      factGone: "This fact isn't in the repo's facts any more, so there is nothing to correct.",
    },
    /** ADR 0124 addendum A-framework: what each repo is built on, read from its build files. */
    builtOn: "Built on",
    builtOnNone: "Not read yet",
    builtOnOne: (name: string, version: string | undefined, where: string) =>
      `${name}${version ? ` ${version}` : ""} (${where})`,
    builtOnModule: (name: string, module: string) => `${name}, in ${module}`,
    builtOnGap: (name: string) => `${name}: none of its patterns are in the facts`,
    /** ADR 0163: the organisation's terms each repo writes, with the role a note gave each. */
    terms: "Terms",
    termsNone: "None in the facts",
    termRole: {
      owner: "its own id",
      consumer: "a consumer it lets in",
      none: "names no system",
      unknown: "open: nothing says what it means yet",
    } as Record<string, string>,
    termOne: (term: string, value: string, role: string, where: string) =>
      `${term} ${value}: ${role} (${where})`,
    // a note's key (8 hex digits, ADR 0163) or its number reads as "note ...", its words quoted
    termNote: (note: number | string) =>
      typeof note === "number" || /^[0-9a-f]{8}$/.test(note)
        ? `note ${note}`
        : `the note "${note}"`,
    builtOnIntro:
      "What each repo's build files declare it is built on, each read from the line that declares it. Where a repo declares a framework and its facts show none of that framework's patterns — a Spring Boot service with no route, a React app with no screen — the entry points were probably missed, and that is a question for a person rather than something to be decided here.",
    kept: "Facts kept",
    rejected: "Rejected",
    redacted: (n: number) => `${n} quote${n === 1 ? "" : "s"} redacted`,
    /** Beta.24: a live-looking secret in a config file, by file and line, never its value. */
    // Beta.24 review: a box an answer's words made, not a system's name, and the two ways to fix it.
    answerBoxes: {
      title: (n: number) =>
        n === 1 ? "A box made from an answer's words" : `${n} boxes made from answers' words`,
      intro:
        "An answer to a question about where calls go was taken as a system's name, so the map drew a box with arrows to it. Say what it was: Ignore leaves its calls off the map; a rename points them at a real system. Both are written here first, then proposed for review.",
      box: (name: string) => `A box made from an answer's words: ${name}`,
      inProfile: (path: string) => `A system in ${path}`,
      answeredIn: (n: number) => `Named by ${n} answer${n === 1 ? "" : "s"}:`,
      ignore: "It was 'ignore this'",
      ignoreOf: (name: string) => `It was 'ignore this': ${name}`,
      rename: "Rename to a real system",
      renameOf: (name: string) => `Rename to a real system: ${name}`,
      nameLabel: "The repo or system it is, or a new outside system's name",
      nameHint:
        "A repo or system Atticus knows, or a short name: letters, digits, spaces and dashes, up to 40 characters, not a sentence.",
      needName: "Type the repo or system it is, or a new system's name.",
      preview: "Preview the change",
      previewing: "Working out the change…",
      willIgnore: (n: number) =>
        `${n} answer${n === 1 ? "" : "s"} become${n === 1 ? "s" : ""} Ignore, and the box leaves the map after Apply:`,
      willRename: (n: number, to: string) =>
        `${n} answer${n === 1 ? "" : "s"} name${n === 1 ? "s" : ""} ${to} instead, after Apply:`,
      answerChange: (id: string, was: string, now: string) => `${id}: “${was}” becomes “${now}”`,
      profileChange: (path: string) => `The lines it changes in ${path}:`,
      confirmIgnore: "Yes, ignore it",
      confirmRename: "Yes, rename it",
      cancel: "Cancel",
      writing: "Writing…",
      written: (repos: string) =>
        `Written here. Apply puts it on the map${repos ? ` (${repos})` : ""}, then propose it for review:`,
    },
    secrets: {
      title: (n: number) =>
        n === 1
          ? "A secret seems to sit in a config file"
          : `${n} secrets seem to sit in config files`,
      at: (file: string, line: number, key: string) => `A secret sits in ${file}:${line} (${key})`,
      /** Review of beta.24: what a line is said by when its key is a secret itself. */
      secretKey: "a key that looks like a secret",
      fix: "Move it to where your secrets live (a vault, an environment variable, a Secret) and read it from there; then rotate it, as it has been in the repo. Atticus never copies its value into a map.",
    },
    coverage: "Coverage",
    coverageOf: (ratio: number, read: number, unknown: number, excluded: number) =>
      `${Math.round(ratio * 100)}%: ${read} file${read === 1 ? "" : "s"} read, ${unknown} not read, ${excluded} excluded`,
    noReport: "No verifier's report yet",
    commit: "Commit",
    sameCommit: (c: string) => `${c.slice(0, 7)}, the checkout's`,
    otherCommit: (facts: string, checkout: string) =>
      `Facts ${facts.slice(0, 7)}, checkout ${checkout.slice(0, 7)}`,
    noCheckout: (facts: string) => `Facts ${facts.slice(0, 7)}; no checkout to compare with`,
    noFactsCommit: "No facts yet",
    catalogFrom: "Catalog from",
    from: {
      facts: "Its facts",
      readers: "The built-in readers",
      both: "Its facts and the readers",
      none: "Nothing yet",
    } as Record<string, string>,
    records: (facts: number, readers: number) =>
      `${facts} record${facts === 1 ? "" : "s"} from facts, ${readers} from readers`,
    unknownFiles: (n: number) => `The ${n} file${n === 1 ? "" : "s"} no fact cites yet`,
    more: (n: number, path: string) => `and ${n} more, listed in ${path}`,
    files: (facts: string, report: string) => `Files: ${facts}, ${report}`,
    // ADR 0135, C3: every count opens what it counts, with the action that closes each.
    none: "None",
    show: (n: number, what: string) => `${n} ${what}: show them`,
    what: {
      kept: "facts kept",
      redacted: "quotes redacted",
      rejected: "lines rejected",
      unknown: "files not read",
      excluded: "files excluded",
      asked: "questions open",
      unverified: "facts not checked",
    } as Record<string, string>,
    asked: "Questions open",
    unverified: "Not checked yet",
    keptFix:
      "Each is checked on its line. Open a citation to see the quote, and Correct this if the fact is wrong.",
    redactedFix:
      "A secret value in the quote was replaced with <redacted> before the facts were kept. Nothing to do: the claim is still checked on its line.",
    rejectedFix: (file: string) =>
      `The cited line doesn't say what the fact claims, or the line isn't a fact. Your assistant fixes each from ${file}, then the verifier checks them again:`,
    rejectedLine: (code: string, message: string) => (message ? `${code}: ${message}` : code),
    rejectedNoLine: "No file or line: the line isn't a fact",
    /** App-only audit: one rejected fact holds the repo; a person may drop it, with why. */
    rejectedHolds: (n: number) =>
      `Nothing is written to the catalog while ${n === 1 ? "a fact is" : `${n} facts are`} rejected: fix ${n === 1 ? "it" : "them"} with your assistant, or drop ${n === 1 ? "it" : "each"} below.`,
    dropFact: "Drop this fact",
    dropFactLabel: (fact: string) => `Drop fact ${fact}`,
    dropFactReason: (fact: string) => `Why is ${fact} wrong?`,
    dropFactHelp:
      "Recorded as your correction (the fact is wrong) with your name, then Apply writes the rest of the repo's facts.",
    dropFactNeedsReason: "Say why the fact is wrong first.",
    dropFactAndApply: "Drop it and apply",
    droppingFact: "Dropping it…",
    dropFactCancel: "Keep it",
    droppedFact: (fact: string) =>
      `Dropped ${fact} as wrong and applied the rest. Propose the correction for review from Home.`,
    unknownFix: (repo: string) =>
      `No fact cites these yet. Have your assistant read them, or exclude generated code in org-pack/scan/${repo}.yaml:`,
    excludedFix: (repo: string) =>
      `Left out of the read by org-pack/scan/${repo}.yaml. If one should be read, take its exclusion out of that file and read the repo again.`,
    askedFix:
      "Atticus asked because the code doesn't say. Answer each; the next verify reads the answer.",
    answer: "Answer it",
    unverifiedFix: "The verifier hasn't checked these on their lines yet:",
    moreFacts: (n: number, file: string) => `and ${n} more, in ${file}`,
    openCanvas: "Open the repo on the estate canvas",
    /** ADR 0141 (P5): which repos' clones have moved past their facts' commit, most stale first. */
    fresh: {
      title: "Freshness",
      intro:
        "Which repos' clones have moved past the commit their facts were read at, and what reading each again costs: the files changed that the facts cite, the facts to read again (the rest are carried as they are), and the command to run. Most stale first. Read from the facts and the clones with local git only; nothing is fetched or written. The same list in a terminal: atticus estate fresh.",
      empty: "No repo is read yet, so none can be stale. atticus next says which to read first.",
      allFresh: (n: number) =>
        `All ${n} repo${n === 1 ? "" : "s"} read ${n === 1 ? "is" : "are"} fresh: the facts are of the commit the clone is at.`,
      summary: (stale: number, read: number, facts: number) =>
        `${stale} of ${read} read moved on · ${facts} fact${facts === 1 ? "" : "s"} to read again`,
      caption: "Repos whose clone has moved past their facts' commit, most stale first",
      col: {
        repo: "Repo",
        state: "State",
        facts: "Facts at",
        clone: "Clone at",
        cited: "Files cited that changed",
        reread: "Facts to read again",
        carried: "Carried",
        run: "Run",
      },
      states: {
        stale: "Read again",
        "unknown-commit": "Commit not in the clone",
        moved: "Moved, nothing cited changed",
        "no-checkout": "No clone",
        fresh: "Fresh",
        "not-read": "Not read yet",
      } as Record<string, string>,
      more: (n: number) => `+${n} more`,
      freshCount: (n: number) =>
        `${n} more repo${n === 1 ? " is" : "s are"} fresh, and not listed here.`,
    },
  },
  /** Change › Knowledge (ADR 0124, Part 5): the org knowledge that applies to the change. */
  changeKnowledge: {
    title: "Knowledge that applies",
    /** On Feature design: where the change's knowledge is now (2026-10-27). */
    onFeature:
      "The pages attached to this change, ranked, with their source, the tasks that use them and the pages that disagree, are on the change's Knowledge page. Confirm or exclude them there.",
    openPage: "Open the change's knowledge",
    intro:
      "What the change's stages picked from the org's knowledge, with why: from the feature stage on, each picks the patterns, standards, decisions, processes and requests, and the wiki and document sections, that its own input leads to. Confirm what applies, and every later stage that takes its kind picks it; exclude what doesn't, and no later stage picks it again.",
    none: "No knowledge is attached to this change yet. The feature stage is the first that picks pages from the org's wikis, documents and standards. Once the brief is written, run:",
    featureCommand: (id: string) => `atticus change feature ${id}`,
    working: "Writing knowledge.yaml…",
    caption: "Knowledge that applies to this change",
    item: "Item",
    why: "Why",
    stages: "Stages",
    status: "Status",
    actions: "Confirm or exclude",
    statuses: {
      suggested: "Suggested",
      confirmed: "Confirmed",
      excluded: "Excluded",
    } as Record<string, string>,
    confirm: "Confirm",
    exclude: "Exclude",
    confirmItem: (name: string) => `Confirm ${name}`,
    excludeItem: (name: string) => `Exclude ${name}`,
    /** Each kind in words (B2): an index kind isn't something a person reads. */
    kinds: {
      Pattern: "Pattern or standard",
      Decision: "Decision",
      ProcessDefinition: "Process or request",
      Party: "Team or vendor",
      Product: "Product",
      GlossaryTerm: "Term",
      SourceDocument: "Document",
      WikiSection: "Wiki section",
      DocumentSection: "Document section",
    } as Record<string, string>,
    nearMisses: (n: number) => `Nearly picked (${n}): left out for room`,
    nearMissStage: (stage: string) => `left out of ${stage}`,
    set: (id: string, status: string, file: string) =>
      `${id} is ${status}, in ${file}. Commit it with the change's files:`,
    copyCommit: "Copy the git command",
    noStages: "a person",
    /** ADR 0132: the source of the page an item is read from, and how much its word counts. */
    fromSource: (source: string, authority?: string) =>
      authority ? `from ${source} (${authority})` : `from ${source}`,
    /** B-task-knowledge: the tasks whose own selection picked it. */
    tasks: (ids: string[] | string) => {
      const all = typeof ids === "string" ? [ids] : ids;
      return `task${all.length === 1 ? "" : "s"} ${all.join(", ")}`;
    },
  },
  /** B-task-knowledge (C4 2.25.0): pages that disagree, and who decided which applies. */
  knowledgeConflicts: {
    title: "Pages that disagree",
    intro:
      "Two pages say different things about the same item. A person decides which applies (or both, in different cases); nothing is picked for them. A signal may suggest a page (it replaces the other, its owner handles the item, its source is tagged for the kind, it is in the team's space, or it was edited last), but only suggests. When code verified in a repo holds one page's value, the code settles it: a document never overrides a fact verified from code.",
    says: (page: string, words: string) => `${page} says "${words}"`,
    open: (id: string) =>
      `Waiting for a person: question ${id} (atticus questions answer ${id} --option <n>, or on the Questions page).`,
    notAsked: "No one has been asked yet; a change that relies on it asks a person which applies.",
    applies: (pages: string, by: string) => `${pages} applies (${by}).`,
    both: (by: string, words?: string) =>
      `Both apply, in different cases (${by}${words ? `: "${words}"` : ""}).`,
    byPerson: (who: string) => `answered by ${who}`,
    byCode: (kind: string, record: string, value: string, at: string) =>
      `settled by the code: ${kind} ${record} has ${value}, verified at ${at}`,
    suggested: (page: string, signal: string, detail: string) =>
      `Suggested, not decided: ${page}, by ${signal} (${detail}).`,
  },
  /** ADR 0114: does the code do what the design says? */
  conformance: {
    title: "Code against design",
    intro:
      "Does the code do what the design says? Each repo's branch is scanned at its commit and checked against the change's target flows: every call, table, column, migration and endpoint they add must be there, every call they remove gone, and nothing they don't name added. Every item cites its file and line. No AI; a person can dismiss a finding as not relevant.",
    none: "No change yet. Start one from a brief, then run its architecture stage.",
    noTargets: (id: string) =>
      `${id} has no target flows yet, so there is nothing to check the code against. Its architecture stage writes them:`,
    notChecked: (id: string) =>
      `${id}'s code hasn't been checked against its target flows yet. A task run checks it when its build passes, or run:`,
    repo: (repo: string, ref: string) => `${repo} at ${ref}`,
    commits: (commit: string, base: string) =>
      `Commit ${commit.slice(0, 12)}, compared with ${base.slice(0, 12)}`,
    task: (task: string) => `Only the steps task ${task} builds`,
    counts: (c: { found: number; missing: number; stillThere: number; unexpected: number }) =>
      `${c.found} found, ${c.missing} missing, ${c.stillThere} still there, ${c.unexpected} not in the design`,
    allGood: "Everything its target flows add is there, and nothing they don't name.",
    itemsCaption: (repo: string) => `What the check looked for in ${repo}, and what it found`,
    status: {
      found: "Found",
      missing: "Missing",
      "still-there": "Still there",
      unexpected: "Not in the design",
    } as Record<string, string>,
    col: {
      status: "Result",
      what: "What",
      step: "Step",
      task: "Task",
      at: "Where",
      finding: "Finding",
    },
    step: (flow: string, item?: number) => (item ? `${flow} item ${item}` : `${flow} trigger`),
    noStep: "no target flow",
    unchecked: "Not checked by a scan",
    uncheckedIntro:
      "A scan can't show these steps, or the facts don't cover them at this commit, so the code couldn't confirm them; a person or a test checks them.",
    gate: (round?: number) =>
      round
        ? `The findings are on the conform gate, round ${round}. Dismiss one as not relevant from the change's findings.`
        : "Nothing was written to the conform gate.",
    problems: "What couldn't be read",
    run: "Check the code again",
    /** Eighth UX walk: the check runs from the app, on the person's click. */
    checking: "Checking the code…",
    checked: "Checked. What it found is below.",
    orTerminal: "Or in a terminal:",
  },
  /** ADR 0109: a change's estimate, from its target flows. */
  /** ADR 0144 (V1): a change's impact, as designed, on its Architecture tab. */
  changeImpact: {
    title: "What this change breaks",
    intro:
      "From the change's target flows: each entry or table they break, who calls or uses it today, the fields that stop crossing and the gateway routes to update, each with the team that owns it. A link the map only guessed may break, and isn't counted as a break until someone confirms it.",
    noTargets: (id: string) =>
      `${id} has no target flows yet, so there is nothing to weigh. Its architecture stage writes them:`,
    nothing: "Its target flows break nothing the map shows.",
    counts: (breaks: number, mayBreak: number, routes: number) =>
      `${breaks} caller${breaks === 1 ? "" : "s"} ${breaks === 1 ? "breaks" : "break"}, ${mayBreak} may break (link guessed), ${routes} gateway route${routes === 1 ? "" : "s"} to update.`,
    owned: (owner: string) => `Owned by ${owner}`,
    why: "Why it breaks",
    gone: "Stops crossing",
    required: "Callers must now send",
    callersCaption: (name: string) => `Who calls or uses ${name}, and whether it breaks`,
    col: { who: "Caller", verdict: "Breaks?", owner: "Owner", where: "Where" },
    breaks: "Breaks",
    mayBreak: (how: string) => `May break (link guessed ${how})`,
    guessWords: {
      "joined-by-path": "by path",
      "joined-by-label": "by a host's first label",
      "joined-by-platform-setting": "by a platform-wide setting",
      "joined-by-folder-name": "by a setting's folder name",
      "joined-despite-conflict": "despite an open host conflict",
      "joined-by-service-name": "by a Service's short name",
    } as Record<string, string>,
    confirm: (rule: string) =>
      `Not counted as a break: the critic's ${rule} asks the caller's owner to confirm each guessed link.`,
    nobody: "The map shows nobody calling or using it.",
    /** ADR 0156: who calls the callers, up the chain. */
    chain: "Up the chain: who calls the callers",
    upstream: (breaks: number, mayBreak: number) =>
      `Up the chain, ${breaks} more ${breaks === 1 ? "breaks" : "break"} and ${mayBreak} may break (resting on a guessed link).`,
    chainCaption: (name: string) => `Who calls the callers of ${name}, hop by hop`,
    chainCol: { who: "Caller", via: "Calls", verdict: "Breaks?", owner: "Owner", where: "Where" },
    via: (via: readonly string[]) => `via ${[...via].join(", ")}`,
    depth: (n: number) => `${n} hops up`,
    restsOwn: (how: string) => `May break (its link guessed ${how})`,
    restsOn: (who: string, how: string) => `May break (rests on ${who}, guessed ${how})`,
    capped: (n: number) =>
      `The walk stops at ${n} hops up; more callers are above the last ones listed.`,
    routes: "Gateway routes to update",
    route: (id: string, callers: readonly string[]) =>
      `${id}: ${[...callers].join(", ")} ${callers.length === 1 ? "calls" : "call"} through it`,
    teams: "Teams to involve",
    noTeam: (why: string) => `no team (${why})`,
    problems: "Notes",
    command: (id: string) => `atticus change impact ${id}`,
  },
  estimate: {
    title: "Estimate",
    intro:
      "How big the change is, counted from its target flows: each step it adds, changes or removes is a unit of work, classed by what it reaches. The days come from the org pack's ranges, summed; every unit and driver says where it comes from. No AI, and never a number nobody stands behind.",
    none: "No change yet. Start one from a brief, then run its architecture stage.",
    noTargets: (id: string) =>
      `${id} has no target flows yet, so there is nothing to size. Its architecture stage writes them:`,
    effort: "Effort",
    effortRange: (p20: number, p80: number, p50: number) =>
      `${p20} to ${p80} developer days (most likely ${p50})`,
    noDays: (units: number) => `${units} unit${units === 1 ? "" : "s"} of work, and no days:`,
    noTable:
      "the org pack has no estimates.yaml, so no unit has a range. Add one with the ranges your teams agree.",
    noMatch: "no class in the org pack's estimates.yaml matches this work.",
    from: (classed: number, units: number) =>
      `from ${classed} of ${units} units of work; the rest need a class and count for nothing yet`,
    calendar: "Calendar",
    waiting: (days: number) => `Waiting, from the release forecast: ${days} working days`,
    longer: (what: "work" | "waiting") =>
      what === "work"
        ? "The work takes longer than the waiting."
        : "The waiting takes longer than the work.",
    noWait: "No waiting worked out: the release forecast couldn't be read.",
    calibration: "Calibration",
    notCalibrated: (source?: string, table?: string) =>
      source
        ? `Not calibrated yet: the ranges are ${source}'s, from ${table ?? "estimates.yaml"}. Once past changes record their effort, the ranges are checked against them.`
        : "Not calibrated yet, and no ranges to calibrate.",
    drivers: "What drives it",
    driversCaption: "What makes the change bigger or riskier, with where it comes from",
    noDrivers: "Nothing makes it bigger or riskier than its units of work.",
    widens: (x: number) => `widens the upper end ${x}×`,
    work: "The work",
    workCaption: (id: string) => `Every unit of work in ${id}`,
    needsClass: "needs a class",
    perRepo: "By repo",
    col: {
      what: "What",
      count: "How many",
      effect: "Effect",
      source: "From",
      repo: "Repo",
      flow: "Flow",
      step: "Step",
      cls: "Class",
      days: "Days",
      units: "Units",
    },
    days: (d: { p20: number; p50: number; p80: number }) => `${d.p20}–${d.p80} (${d.p50})`,
    problems: "What couldn't be read",
  },
  /** ADR 0108: a change's picture, from its target flows. */
  changeDiagram: {
    title: "Change diagram",
    intro:
      "What the change touches, drawn from its target flows: each component, entry and table, marked + new, ◇ changed or ✕ retired; the rest is there for context. A part is new only when the target flow says so.",
    pick: "Change",
    none: "No change yet. Start one from a brief, then run its architecture stage.",
    noTargets: (id: string) =>
      `${id} has no target flows yet, so there is nothing to draw. Its architecture stage writes them:`,
    legend: "Legend",
    legendNew: "+ New",
    legendModify: "◇ Changed",
    legendRetire: "✕ Retired",
    legendContext: "Unmarked: there for context",
    parts: "Every part and its mark",
    caption: (id: string) => `The parts of ${id}'s picture`,
    lines: "Every line and its mark",
    col: {
      part: "Part",
      kind: "Kind",
      in: "In",
      mark: "Mark",
      from: "From",
      to: "To",
      what: "What",
    },
    mark: { new: "New", modify: "Changed", retire: "Retired", none: "Context" } as Record<
      string,
      string
    >,
    from: (n: number, source: string) =>
      `Drawn from ${n} target flow${n === 1 ? "" : "s"} in ${source}.`,
    problems: "What couldn't be drawn",
    mermaid: "The same picture as Mermaid",
    mermaidHint: "Paste it into a pull request, a wiki or a chat that draws Mermaid.",
    copyMermaid: "Copy the Mermaid",
    flows: (id: string) => `The target flows of ${id}, step by step`,
  },
  /** ADR 0179: a change drawn on the canvas, stroke by stroke, into its target flows. */
  sketch: {
    title: "Draw the change",
    /** Seventh UX walk: where today's flows and their ids are, for a step taken out. */
    openFlows: "Find today's flows and their ids on Flows",
    intro:
      "Say a stroke: a call one component makes to another, a topic it publishes, a table it reads or writes, or a step of today's flow taken out or sent elsewhere. Preview shows the lines it adds to the change's target flows; Draw writes them and the picture redraws with the stroke marked. A stroke is a plan for the pull request, never a fact.",
    kind: "Stroke",
    kinds: {
      call: "A call",
      topic: "A topic",
      table: "A table",
      remove: "A step taken out",
      retarget: "A step sent elsewhere",
      retire: "A component retired",
    },
    /** ADR 0189: the component a retire stroke takes away (every flow of it today goes). */
    retireComponent: "Component to retire",
    from: "From component",
    flow: "On flow",
    flowOptional: "On flow (left out: its one flow)",
    pickFlow: "Pick the flow…",
    newFlow: "A new flow (the component has none fitting, or is new)",
    newName: "What a person calls the new flow",
    newId: "Its id (left out: made from the name)",
    trigger: "What starts it",
    triggers: {
      endpoint: "An endpoint is called",
      action: "A user action",
      page: "A page opens",
      listener: "A message arrives",
      job: "A job runs",
    },
    triggerWhat: "In words",
    componentWord: "component",
    flowWord: "flow",
    newType: "What the new box is",
    newTypeNone: "A type isn't said yet",
    typeOption: (name: string, badge?: string) => (badge ? `${name} [${badge}]` : name),
    typeMustNot: (rules: readonly string[] | string) =>
      `Must not: ${typeof rules === "string" ? rules : rules.join(" · ")}`,
    todayFlow: "Today's flow (its id)",
    step: "Step number (1 is the first)",
    toComponent: "To component",
    toEntry: "Its API (METHOD /path, an Endpoint id, or a topic)",
    toEntryExample: "POST /v1/screenings",
    flowOption: (name: string, id: string) => `${name} (${id})`,
    drawnBy: (by: string) => `by ${by}`,
    toNew: "The API doesn't exist yet",
    topic: "Topic or queue",
    listener: "A component that listens (optional)",
    listenerFlow: "On its flow (left out: its one flow)",
    op: "Reads or writes",
    ops: { read: "Reads", write: "Writes", lookup: "Looks up" },
    table: "Table (store.table)",
    tableExample: "orders-db.screenings",
    columns: "Columns, comma-separated (optional)",
    tableNew: "The table doesn't exist yet",
    what: "What the step does (optional)",
    why: "Why",
    missing: {
      from: "Say the component the stroke starts from (and, for a new flow, its name and what starts it).",
      to: "Say the component it goes to and which API.",
      topic: "Say the topic.",
      table: "Say the table.",
      step: "Say today's flow and the step number.",
      why: "Say why.",
      component: "Say the component to retire.",
    },
    preview: "Preview",
    previewing: "Previewing…",
    draw: "Draw it",
    drawing: "Drawing…",
    previewSays:
      "Draw it writes exactly these lines (the flow's target file, and design.md where Atticus wrote it):",
    written:
      "Drawn. The picture shows it. Propose the drawing for review now, or let it ride the stage's hand-off.",
    copy: "Copy",
    drawnTitle: "Strokes drawn here",
    drawnNone: "None yet.",
    undo: "Undo",
    undoing: "Undoing…",
    fill: "Fill in the rest: the architecture stage keeps every drawn step and drafts the ones around them.",
  },
  runNext: {
    title: "Run next",
    copy: "Copy the command",
    copySlash: "Copy the slash command",
    terminal: "In a terminal, at the metarepo:",
    slash: "Or type this in Copilot Chat or Claude Code:",
    slashIn: (where: string) => `Or type this in Copilot Chat or Claude Code in ${where}:`,
    noSlash: "No slash command does this step yet. Run the command in a terminal.",
    /** Seventh UX walk: the step's in-app action comes first; the command is kept under this. */
    orTerminal: "Or in a terminal",
    openTaskBoard: "Open the Task board",
    taskOnBoard:
      "Run the task with AI on the Task board: Atticus prepares its prompt, checks the result and raises its PR on your click.",
    writeBrief: "Write the brief on the Brief tab",
    answerOnQuestions: "Answer them on Questions",
    openPr: "Open the hand-off PR",
    openRelease: "Open Release",
    /** Eighth UX walk: blocking findings hold the hand-off; they are resolved on the change's page. */
    resolveFindings: "Resolve them on the change's page",
    /** Ninth UX walk: a knowledge gap holds the gate; it is answered on the change's page. */
    answerGap: "Answer it on the change's page",
    answerGapSay:
      "A missing fact is settled on the change's page: Apply fix, ask its owner (Ask), or say it isn't relevant, with a reason.",
    resolveFindingsSay:
      "Each blocking finding is resolved on the change's page: Apply fix, Not relevant or Waive, with a reason.",
    /** Eighth UX walk: a step the app has no control for opens the change's At a glance. */
    openGlance: "Open At a glance",
    /** Eighth UX walk: map questions don't hold a change's step; Home says how many are open. */
    mapQuestions: (n: number) => `${n} map question${n === 1 ? "" : "s"} open.`,
    mapQuestionsLink: "Answer them on Questions",
    whatNext:
      "Not sure what comes next? Type /atticus-next in Copilot Chat or Claude Code, or run atticus next.",
    after: "After that",
    install:
      "atticus assistant-files writes the slash commands into the metarepo, where Copilot Chat and Claude Code both read them:",
    /** ADR 0104: the Atticus plugin for Claude Code. */
    plugin:
      "For Claude Code, add the Atticus plugin: it carries the metarepo's slash commands, and says the next step when a session starts in a metarepo.",
    /** The slash commands `atticus assistant-files` writes today, and what each does. */
    commands: [
      {
        name: "/atticus-next",
        args: "[--all]",
        where: "metarepo",
        what: "Says the next step to take, its command and why.",
      },
      {
        name: "/atticus-map",
        args: "<repo>",
        where: "metarepo",
        what: "Reads a repo into facts, each citing its line; Atticus checks every one and the assistant loops until all pass.",
      },
      {
        name: "/atticus-probe",
        args: "",
        where: "metarepo",
        what: "Shows Atticus what the assistant can do here (open a file, write one, run a command) after atticus probe, so the first read of a repo is handed to it the way it can take it.",
      },
      {
        name: "/atticus-propose",
        args: "[question id]",
        where: "metarepo",
        what: "Reads the code and config behind each open question and proposes an answer with the lines it rests on; Atticus checks every citation, and a person accepts it or answers otherwise.",
      },
      {
        name: "/atticus-survey",
        args: "<repo>",
        where: "metarepo",
        what: "Drafts a repo's scan settings; Atticus checks them against the code.",
      },
      {
        name: "/atticus-verify",
        args: "<repo>",
        where: "metarepo",
        what: "Compares a repo's code with its last scan; Atticus checks every item.",
      },
      {
        name: "/atticus-spec",
        args: "<repo>",
        where: "metarepo",
        what: "Writes a repo's spec of flows and loops until the spec check passes.",
      },
      {
        name: "/atticus-answer",
        args: "[question]",
        where: "metarepo",
        what: "Explains the open questions; the person chooses each answer.",
      },
      {
        name: "/atticus-knowledge",
        args: "<source>",
        where: "metarepo",
        what: "Reads a knowledge source into items; Atticus checks every quote.",
      },
      {
        name: "/atticus-find",
        args: "<term or phrase>",
        where: "metarepo",
        what: "Searches every wiki for it and proposes what the pages hold about it; Atticus checks every quote.",
      },
      {
        name: "/atticus-needs",
        args: "<change>",
        where: "metarepo",
        what: "Says what a change needs from the organisation: requests to raise, standards to follow, teams to involve.",
      },
      {
        name: "/atticus-feature",
        args: "<change>",
        where: "metarepo",
        what: "Places a change on the estate's flows and features, looping with the checks and critic.",
      },
      {
        name: "/atticus-architecture",
        args: "<change>",
        where: "metarepo",
        what: "Writes a change's target flows from its feature, looping with the checks and critic.",
      },
      {
        name: "/atticus-stories",
        args: "<change>",
        where: "metarepo",
        what: "Writes a change's stories and tasks from its approved design.",
      },
      {
        name: "/atticus-small",
        args: "<change>",
        where: "metarepo",
        what: "Plans a small change in one step: its place on the flows, its target flows and its stories.",
      },
      {
        name: "/atticus-draft",
        args: "<change>",
        where: "metarepo",
        what: "Drafts a change's proposal, spec and interfaces from its brief and the catalog.",
      },
      {
        name: "/atticus-attach",
        args: "<change> <files…>",
        where: "metarepo",
        what: "Attaches a spec, screenshot, PDF or document to a change, for its steps to read and cite.",
      },
      {
        name: "/atticus-knowledge-ask",
        args: "<question>",
        where: "metarepo",
        what: "Answers a question from the knowledge items only, citing each one.",
      },
      {
        name: "/atticus-ask",
        args: "<question>",
        where: "metarepo",
        what: "Answers a question about the systems from the catalog.",
      },
      {
        name: "/atticus-impact",
        args: "<record id>",
        where: "metarepo",
        what: "Lists what a change to one record reaches.",
      },
      {
        name: "/atticus-critic",
        args: "<change>",
        where: "metarepo",
        what: "Reviews a change with the critic's AI lenses, one at a time; every finding is recorded.",
      },
      {
        name: "/atticus-plan",
        args: "<change>",
        where: "metarepo",
        what: "The old name of /atticus-stories, kept for one version.",
      },
      {
        name: "/atticus-snow",
        args: "<change>",
        where: "metarepo",
        what: "Drafts the service-desk requests a change needs.",
      },
      {
        name: "/atticus-release",
        args: "<change>",
        where: "metarepo",
        what: "Checks whether a change is ready to release.",
      },
      {
        name: "/atticus-task",
        args: "<change> <task>",
        where: "metarepo",
        what: "Starts a task with its context loaded: its story, criteria, today's code and the files to change. In a code repo, /atticus-task <task>.",
      },
    ],
  },
  work: {
    loading: "Loading",
    unreadable: "These files couldn't be read:",
    // Home's overview (the Overview, merged into Home on 2026-10-24)
    estate: "What is read and trusted",
    coverage: "Onboarded and read",
    reposListed: "repos in the manifests",
    reposCloned: "cloned",
    reposScanned: "in the catalog",
    records: "facts in the catalog",
    openOnboarding: "Open Onboarding",
    trustNone: "No repo is listed yet, so there is no map to trust.",
    allTrusted:
      "Every repo's map is trusted: its facts are verified and of the commit checked out.",
    notTrusted: "Not trusted yet",
    openTrust: "Open Map › Trust",
    inFlight: "Changes in flight",
    noChanges: "No change is in flight. Start one with New change.",
    stageCol: "Stage",
    changeCol: "Change",
    stateCol: "State",
    commandCol: "Run",
    slashTitle: "Slash commands in Copilot Chat and Claude Code",
    slashIntro:
      "These slash commands are in Copilot Chat once atticus assistant-files has written them, and in Claude Code through the Atticus plugin. In each AI step your assistant does the model work and Atticus checks it.",
    slashWhere: { metarepo: "the metarepo", repo: "a code repo" },
    // Onboarding
    onbIntro:
      "Pick the repos, connect the knowledge sources, then run the steps in order. Each step is a command; this page shows which one is next.",
    steps: "Steps, in order",
    stepPick: "Pick the repos: edit the manifest. Each repo is one entry.",
    stepPickNone:
      "There is no manifest yet. Propose one from a folder of clones or your Git host's organisation:",
    stepAddOne:
      "Or add one repo at a time, saying what it is in your own words. That line goes into every reading prompt, the questions a join asks and these views:",
    stepSync: "Clone the repos, or bring the clones up to date:",
    stepRead: "Have your assistant read each repo and write its facts, each citing its line:",
    stepWrite: "Check the facts against the code and put them in the catalog:",
    stepAnswer: "Answer the questions the scan raised:",
    stepAnswerLink: "Open the Questions page",
    stepTrust: "See how far to trust each repo's map, and the files not read yet:",
    done: "DONE",
    todo: "TO DO",
    repos: "Repos",
    noRepos: "No repos in any manifest yet.",
    repoCol: "Repo",
    // ADR 0128: what each repo is, in a person's words, beside its id.
    aboutCol: "What it is",
    aboutDraft: "Unconfirmed draft",
    aboutMissing: "Nothing says yet. Say what it is, in one line:",
    typeCol: "Type in the manifest",
    matchCol: "Matched repo type",
    matchHint: "Run to see the match and its evidence:",
    cloneCol: "Clone",
    cloned: "CLONED",
    notCloned: "NOT YET",
    settingsCol: "Scan settings",
    settingsMissing: "none yet",
    lastScanCol: "In the catalog",
    notScanned: "nothing yet",
    recordCount: (n: number) => `${n} fact${n === 1 ? "" : "s"}`,
    atCommit: (c: string) => `at ${c.slice(0, 7)}`,
    sources: "Knowledge sources",
    sourcesMissing: (path: string) =>
      `${path} isn't there. Add a wiki on Set up › Org pack (Add a wiki), or with atticus sources add <type> <location>.`,
    sourcesNone: (path: string) => `${path} lists no wikis or absorbed repos yet.`,
    sourcesFile: "File",
    wikiCol: "Wiki",
    kindCol: "Kind",
    whereCol: "Location",
    spacesCol: "Spaces",
    ownerCol: "Owner",
    absorbedTitle: "Absorbed repos",
    syncSources: "Read the wikis:",
    // The stage screens
    pickChange: "Change",
    noChangeYet: "No change yet. Start one with New change, or on the command line:",
    noChangeTitle: "No change yet",
    /** UX review: the stage's work is on these pages. */
    /** Eighth UX walk: one path to write stories, the stories stage's Prepare; Breakdown reads. */
    openBreakdown: "Open Breakdown",
    openBreakdownWhy: "for how ready each story is and what no story covers yet.",
    /** Seventh UX walk: the stories themselves, on the Stories tab, each with Edit. */
    storiesIndex: "The stories",
    storyFile: (id: string) => `Story ${id}`,
    noStoryFiles: "No story is written yet: Prepare the stories stage above to write them.",
    /** Eighth UX walk: the feature stage's placement (feature.md) on Feature design. */
    placementTitle: "Where the feature lands",
    placementText: "feature.md, where the feature lands",
    placementNotYet:
      "The feature stage hasn't placed this change yet. Its run writes feature.md here: the feature in a few sentences, the flows it touches and the gaps.",
    placementNotDrawn:
      "feature.md isn't drawn yet. Save in Edit, or the stage's next run, draws it from feature.yaml.",
    draftedByAiWhy:
      "The AI drafted it at the feature stage, and no person has edited it here since (The drafts below says which run). Read it before the hand-off; Edit changes feature.yaml, which the stage's next run reads.",
    editedBy: (who: string) => `Edited by ${who}`,
    editedByPerson: "Edited by a person",
    editedByWhy: (who: string, day: string) =>
      `${who} saved feature.yaml${day ? ` on ${day}` : ""}; feature.md is drawn from it.`,
    editedByHand: "feature.yaml was edited outside the app; feature.md is drawn from it.",
    editPlacement: "Edit",
    editPlacementLabel: "Edit feature.yaml, where the feature lands",
    placementEditTitle: "Edit feature.yaml",
    placementSourceHint:
      "feature.md is drawn from feature.yaml. Change the summary, the flows and the gaps here: Save checks it still reads as a placement and draws feature.md again, and the stage's next run reads your edit.",
    placementSourceLabel: "feature.yaml text",
    placementSave: "Save",
    placementCancel: "Cancel",
    placementClose: "Close",
    placementSaved:
      "Saved feature.yaml and drew feature.md from it. Both ride the feature hand-off.",
    openTaskBoard: "Run tasks with AI",
    openTaskBoardWhy:
      "on the Task board: each task runs on its repo and ends as a pull request a person approves.",
    noChangeCommand: 'atticus change new "<title>" --type <type>',
    noChangeLink: "All changes lists every change once you start one.",
    /** A change's tab opened with no change in its address. */
    pickAChangeTitle: "Pick a change",
    pickAChange:
      "This tab is about one change. Pick it in All changes, and every tab of Change follows it.",
    openAllChanges: "Open All changes",
    stageIs: (stage: string) => `This change is at the ${stage} stage.`,
    goStage: (page: string) => `Open ${page}`,
    files: "The change's files",
    noFiles: "No files for this change yet.",
    fileCol: "File",
    statusCol: "Status",
    tasks: "Tasks",
    noTasks: "No tasks yet. Write them with atticus plan stories <change>.",
    taskCol: "Task",
    repoTaskCol: "Repo",
    runCol: "Run it",
    taskDone: "DONE",
    taskOpen: "OPEN",
    /** Seventh UX walk: a task's row goes to its row on the Task board, where it runs. */
    openOnBoard: "Open on the Task board",
    openOnBoardLabel: (task: string) => `Open task ${task} on the Task board`,
    runOnBoard: "Run with AI there, or mark it done.",
    fromTerminal: "From a terminal or your assistant",
    taskInRepo: (repo: string) =>
      `Prints the same context for any assistant, to read before coding in ${repo}.`,
    stage: {
      feature: "feature",
      architecture: "architecture",
      stories: "stories",
      tasks: "tasks",
      release: "release",
      done: "done",
    },
    why: {
      discover: "There are no repos to work on until a manifest lists them.",
      sync: (n: number) => `${n} repo${n === 1 ? " isn't" : "s aren't"} cloned yet.`,
      /** ADR 0124: a repo read by the assistant and verified, by its state on Map › Trust. */
      read: {
        "not-read": (repo: string) =>
          `${repo} isn't read yet: your assistant reads it and writes its facts, each citing its line, and atticus verify checks every one.`,
        unverified: (repo: string) =>
          `${repo}'s facts aren't verified yet: atticus verify checks each against the line it cites.`,
        rejected: (repo: string) =>
          `Some of ${repo}'s facts were rejected: your assistant fixes them from the rejected file, then verify runs again.`,
        stale: (repo: string) =>
          `${repo}'s facts are of another commit than its checkout: your assistant reads what changed again.`,
        unwritten: (repo: string) =>
          `${repo}'s facts are verified but not in the catalog yet: atticus verify --write puts them there.`,
      },
      write: (repo: string) =>
        `When the read is done, atticus verify ${repo} --write checks the facts and puts them in the catalog.`,
      answer: (n: number) =>
        `${n} question${n === 1 ? " is" : "s are"} waiting. Answer on the Questions page; it shows the command to rerun.`,
      answerUnknown:
        "The open questions couldn't be read just now, so this step isn't ticked yet. Open the Questions page to see them.",
      onboarded:
        "Every repo is read and its facts verified. Map › Trust says how far to trust each repo's map; atticus next says what comes next.",
      change: (id: string, stage: string) => `${id} is at the ${stage} stage.`,
      newChange: "Everything is onboarded and no change is in flight. Start one.",
      feature:
        "Your assistant places the change on the estate's flows and features; Atticus checks and criticises every draft until nothing blocks.",
      architecture:
        "Your assistant writes the target flows; Atticus checks and criticises every draft until nothing blocks.",
      stories: "Writes the stories, stories.md and tasks.md from the approved design.",
      task: (task: string, repo: string) =>
        `Task ${task} in ${repo} is the next open one. /atticus-task gives your assistant its context: the story, the criteria, the step with today's code and the files to change.`,
      small:
        "A small change: your assistant places it, writes its target flows and words its stories in one step; Atticus runs every stage's checks and the critic at its gate.",
      later: "The change is past this stage; its status says what it needs now.",
      refresh:
        "The diagram is drawn from the catalog. When a repo's code has changed, your assistant reads it again and atticus verify --write puts its facts in the catalog.",
      /** A stage tab whose own stage is done: the change waits on its gate (2026-10-25). */
      stageDone: (stage: string, next: string) =>
        `The ${stage} stage is done; the change now waits on its hand-off gate. ${next}`,
      stageBlocked: (stage: string, reason: string) =>
        `The ${stage} stage is done, but the gate can't be raised yet: ${reason}`,
      stageUnderWay: (stage: string, state: string) =>
        state === "questions"
          ? `The ${stage} stage waits for answers to its questions; run it again once they are answered.`
          : state === "waiting"
            ? `The ${stage} stage is with your assistant: finish its hand-off, then run it again.`
            : state === "stopped"
              ? `The ${stage} stage stopped for a person to fix a file; run it again once it is fixed.`
              : `The ${stage} stage is drafting; run it again to go on.`,
      critic: "Reviews the change's files against the checklists.",
      handoff: "Opens the stage's hand-off PR; merging it approves the stage.",
      questionsList: "Lists the open questions with their files.",
    },
    architectureIntro:
      "The diagram is drawn from the catalog. A change at the design stage shows its next step here.",
  },
  shell: {
    aiOff: "AI OFF",
    textOnlyAi: "TEXT-ONLY AI",
    aiIsOffIn:
      "AI is off in this organisation: no AI step runs; people write and the rule checks review.",
    imageReadingIsOff: "Image reading is off: pictures go to a person in Intake.",
    setYourGitUser: "SET YOUR GIT USER",
    recordedAs: (root: string | number, v: string | number, user: string | number) =>
      `${root}${v} · recorded as ${user}`,
    askAtticus: "Ask Atticus",
    /** The Ask box's example, from the person's own catalog (a real table or entry), else neutral. */
    askWhatBreaksIf: (id: string) => `Ask: what breaks if ${id} changes?`,
    askNeutral: "Ask: who calls a component, or what breaks if a table changes?",
    ask: "Ask",
    help: "Help",
    replayTheTour: "Replay the tour",
    skipToContent: "Skip to content",
  },
  /**
   * ADR 0194: the IDE layout (beta.26): a title bar, an activity bar of the sections, a side
   * panel, a tab per open page, the page, the bottom panel and a status bar.
   */
  ide: {
    /** The title bar's box: it opens Ctrl+K. */
    search: "Search the estate, ask, or run a command",
    /** The metarepo's folder, beside the logo. */
    metarepo: (name: string) => `${name} · metarepo`,
    sideShow: "Show the side panel",
    sideHide: "Hide the side panel",
    resize: "Resize the side panel",
    /** The tab strip. */
    tabs: "Open pages",
    tabHint: "Delete closes this tab. Ctrl+Shift+Left or Right moves it.",
    closeTab: (label: string) => `Close ${label}`,
    tabTitle: (change: string, page: string) => `${change} · ${page}`,
    /** Activity bar badges, heard after the section's name. */
    openCount: (n: number) => `${n} open`,
    more: "More pages",
    settings: "Settings",
    /** The status bar. */
    status: "Status",
    repos: (n: number) => `${n} repo${n === 1 ? "" : "s"}`,
    questions: (n: number) => `${n} question${n === 1 ? "" : "s"} open`,
    running: (title: string) => `${title} running`,
    step: (done: number, total: number) => `${done}/${total}`,
    alsoRunning: (n: number) => `+${n}`,
    api: (v: string) => `local API ${v}`,
    version: (v: string) => `v${v}`,
    who: (user: string, role?: string) => (role ? `${user} · ${role}` : user),
    /** Embedded in an editor: the few title-bar buttons, beside the tabs. */
    tools: "Page tools",
    /**
     * Ctrl+K's commands for the bottom panel (review, beta.26): each only shows a tab of it,
     * nothing is written. `also`: other words each is found by.
     */
    panelCommands: {
      console: "Open the Console",
      questions: "Show the open questions in the panel",
      problems: "Show the problems",
      runs: "Show the recent runs",
      detail: "bottom panel",
      also: {
        console: ["console", "log", "output", "terminal"],
        questions: ["questions", "panel"],
        problems: ["problems", "failed", "blocking", "rejected", "errors"],
        runs: ["runs", "recent", "history", "jobs"],
      } as Record<"console" | "questions" | "problems" | "runs", readonly string[]>,
    },
    /** The layout setting (Settings, and Ctrl+K). */
    layout: {
      title: "Layout",
      meta: "this browser",
      legend: "How the app is laid out",
      ide: "IDE (new)",
      ideWhat: "An activity bar, a side panel, a tab per open page and a status bar.",
      classic: "Classic",
      classicWhat: "The menu on the left and one page at a time, as before beta.26.",
      kept: "Kept in this browser. The classic layout stays available for this release.",
      toClassic: "Switch to the classic layout",
      toIde: "Switch to the IDE layout",
      commandDetail: "layout, this browser",
    },
  },
  boundary: {
    appCouldntBeShown: "Atticus couldn't be shown",
    somethingInTheApp: (error: string | number) =>
      `Something in the app failed: ${error}. Go to Home to carry on; if it happens again, reload.`,
    goHome: "Go to Home",
    couldntBeShown: (name: string | number) => `${name} couldn't be shown`,
    somethingOnThisScreen: (error: string | number) =>
      `Something on this screen failed: ${error}. The other screens still work; reload to try again.`,
  },
  flowView: {
    andMore: (shown: string, n: number) => `${shown} and ${n} more`,
    nodesInGroupsEdges: (
      title: string | number,
      v: string | number,
      v2: string | number,
      v3: string | number,
    ) => `${title}: ${v} nodes in ${v2} groups, ${v3} edges.`,
    callsInsideIt: (v: string | number) => `, ${v} calls inside it`,
    edgePointAtAnother: (
      v: string | number,
      hotEdgesLength: string | number,
      v2: string | number,
      v3: string | number,
      v4: string | number,
    ) =>
      `${v}: ${hotEdgesLength} edge${v2}${v3}${v4}. Point at another box, or click it again to clear.`,
    everythingHereIsOne:
      "Everything here is one system: open Container to see its components and how they connect.",
    edgesPointAtA: (v: string | number) =>
      `${v} edges. Point at a box to light its edges; dashed lines are asynchronous.`,
  },
  menu: {
    atticus: "ATTICUS",
    askAtticus: "Ask Atticus",
    /** At the bottom of the menu: every page the six entries' tabs don't show (2026-10-25). */
    morePages: "More pages",
    /** The keys that open Ctrl+K: Cmd on a Mac. */
    keysMac: "Cmd+K",
    keys: "Ctrl+K",
    /** The hint under More pages; a click opens it too (an editor's panel may take the keys). */
    anyPage: (keys: string) => `${keys}: any page`,
  },
  palette: {
    kinds: {
      screen: "page",
      change: "change",
      record: "record",
      ask: "ask",
      command: "command",
    } as Record<string, string>,
    askItem: (question: string) => `Ask: ${question}`,
    askDetail: "answer from the catalog, with the query shown",
    goToAScreen: "Go to a screen, change or record, or ask a question",
    goToAScreen2: "Go to a screen, change or record… or ask a question",
    nothingMatches: "Nothing matches.",
    results: "Results",
    toMoveEnterTo: "↑ ↓ to move · Enter to open · Esc to close",
    goToAnything: "Go to anything",
  },
  tour: {
    tourOf: (step: string | number, steps: string | number, escape: string | number) =>
      `Tour · ${step} of ${steps} · ${escape}`,
    /** The tour's steps, in order. */
    steps: {
      home: {
        title: "Your home",
        body: "Home is one page. First what needs a person across every change (changes in each phase, blocking findings, open needs, questions and manual steps) and the step to run next; then what is read and trusted, and each change in flight with the stage it is at. Beside it: Map, Change, Questions, Knowledge and Set up. Everyone sees the same screens; Ctrl+K jumps anywhere.",
      },
      ask: {
        title: "Ask in plain words",
        body: "Type a question such as “who calls <a component>?” or “what breaks if <a table> changes?” in the box at the top. Atticus answers from the catalog and always shows the query it ran.",
      },
      change: {
        title: "One change, a tab per stage",
        body: "Change opens on All changes: pick one, and the tabs follow it. At a glance says where the change is and what blocks it; then a tab for each stage: feature, architecture, stories and tasks. Each shows that stage's files and the command to run next; Feature also lists the org knowledge that applies, to confirm or exclude. Watch a change you aren't on, and your digest says how it is doing.",
      },
      assistant: {
        title: "Run a step in your assistant",
        body: "The AI steps run in your assistant, not here: type /atticus-next in Copilot Chat or Claude Code and it says what comes next and runs it when you ask. Its questions come back here to answer, and this page follows along.",
      },
      approve: {
        title: "Approving is the pull request",
        body: "Each phase ends with a hand-off PR in the metarepo. Merging it approves the gate; your Git host's rules decide who may approve. Atticus records you by your Git user.",
      },
    },
    skipTheTour: "Skip the tour",
    back: "Back",
    next: "Next",
    done: "Done",
  },
  /** WP5.1: the words nobody outside Atticus knows; the same list as atticus explain <term> (learn's glossary). */
  glossary: {
    title: "What the words mean",
    intro:
      "Atticus's own words, each in one plain sentence. atticus explain <word> says the same on the command line.",
    link: "Words",
    linkTitle: "What Atticus's words mean",
    terms: [
      {
        term: "metarepo",
        says: "The Git repo Atticus keeps for your estate: the catalog read from your repos' code, the changes in flight, the knowledge and the org pack. Its pull requests are how things get approved.",
      },
      {
        term: "org pack",
        says: "Your organisation's settings for Atticus, in org-pack/: the repos and their types, the change types, the checklists and how AI runs here, changed through a pull request.",
      },
      {
        term: "catalog",
        says: "What Atticus read from your code: systems, components, endpoints, tables, settings and how they connect, each citing the file and line it came from.",
      },
      {
        term: "estate",
        says: "All your systems and the repos behind them, as the catalog describes them.",
      },
      {
        term: "flow",
        says: "One path through your code from a trigger (an endpoint, a job, a message) to what it reads, writes and returns, step by step, read from the code.",
      },
      {
        term: "change",
        says: "A piece of work from idea to release, kept in the metarepo with its brief, its design, its stories and its tasks.",
      },
      {
        term: "target flow",
        says: "How a flow will run once a change is in: the steps it adds, changes or removes, with what each reads and writes.",
      },
      {
        term: "hand-off",
        says: "The pull request in the metarepo that ends a phase of a change; merging it approves the phase's gate.",
      },
      {
        term: "gate",
        says: "The point between two phases of a change where its findings are checked and a person approves, by merging the hand-off pull request.",
      },
      {
        term: "finding",
        says: "Something the critic or a check raised about a change (blocking, a risk, a gap or an idea), citing where it is; a person decides what to do with it.",
      },
      {
        term: "critic",
        says: "The AI reviewer that reads a change at a gate, one lens at a time, and raises findings.",
      },
      {
        term: "lens",
        says: "One way the critic reads a change, such as security, data or architecture, each with its own rules.",
      },
      {
        term: "checking round",
        says: "One more critic round after a gate's rounds are used, which reviews only what a person fixed.",
      },
      {
        term: "question",
        says: "Something Atticus asked a person because the code doesn't say, with options and the lines it read; the answer is kept in the metarepo for the steps that read it.",
      },
      {
        term: "knowledge item",
        says: "A fact read from a wiki or a document you added (a process, a standard, a decision, a team), quoted with its page, until a person verifies it.",
      },
      {
        term: "need",
        says: "Something a change needs from the organisation, such as a firewall rule or an access request, with how to ask for it and who handles it.",
      },
      {
        term: "dialect",
        says: "The rules that tell Atticus's scanner how to read one framework or language, your own house frameworks included.",
      },
      {
        term: "base clone",
        says: "Atticus's own read-only copy of a repo, in the metarepo's workspace/, which the scans read; it never touches your working copy.",
      },
      {
        term: "slash command",
        says: "A command you type in your assistant's chat, such as /atticus-next, that runs one Atticus step with the assistant's model.",
      },
      {
        term: "service desk",
        says: "Your operations ticketing system, where a change's release and access requests are raised.",
      },
    ],
  },
  /** One filter box wherever a list grows (ADR 0105 addendum), the same words in the extension. */
  filter: {
    label: "Filter",
    placeholder: "Words to match, for example forge-ledger",
    shown: (n: number, of: number) => `${n} of ${of} shown`,
    words: (text: string) => `“${text}”`,
    inRepo: (repo: string) => `in ${repo}`,
    inChange: (change: string) => `in ${change}`,
    among: (kind: string) => `among ${kind}`,
    nothingMatches: (what: string) => `Nothing matches ${what}.`,
    clear: "Clear the filter",
    repo: "Repo",
    allRepos: "All repos",
  },
  common: {
    nothingHereYet: "Nothing here yet.",
    of: (label: string | number, value: string | number, max: string | number) =>
      `${label}: ${value} of ${max}`,
  },
  across: {
    findings: "Findings",
    tasks: "Tasks",
    stories: "Stories",
    tests: "Tests",
    requests: "Requests",
    releases: "Releases",
    needs: "Needs",
    change: "Change",
    severity: "Severity",
    finding: "Finding",
    where: "Where",
    state: "State",
    task: "Task",
    repo: "Repo",
    what: "What",
    done: "Done",
    story: "Story",
    title: "Title",
    repos: "Repos",
    written: "Written",
    requirementsTested: "Requirements tested",
    gaps: "Gaps",
    firstGaps: "First gaps",
    request: "Request",
    for: "For",
    missing: "Missing",
    risk: "Risk",
    next: "Next",
    handOff: "Hand-off",
    noFindingsOnAny: "No findings on any open change. Run the critic on a change to review it.",
    noTasksYetTasks: "No tasks yet: tasks come with a change's plan.",
    noStoriesYetWrite: "No stories yet: write them on a change's Breakdown.",
    noOpenChangesTo: "No open changes to trace.",
    noServiceRequestsDrafted: "No service requests drafted on any open change.",
    noOpenChanges: "No open changes.",
    notYet: "not yet",
    noneOpen: "none open",
    /** Seventh UX walk: a manual Git host's hand-off PR no person has opened yet. */
    handOffManual: (phase: string) => `${phase} · waits on a manual step`,
    acrossChanges: "Across changes",
    ofAcrossOpenChange: (
      rowsLength: string | number,
      v: string | number,
      changes: string | number,
      v2: string | number,
    ) => `${rowsLength} of ${v} across ${changes} open change${v2}`,
    acrossOpenChanges: (label: string | number) => `${label} across open changes`,
    nothingMatches: (text: string | number) => `Nothing matches “${text}”.`,
    acrossChanges2: (label: string | number) => `${label} across changes`,
    // ADR 0105: needs across changes.
    needsIntro:
      "Every open need of every open change: the requests to raise, the standards to follow and the teams to involve. Done, Not needed and Reopen work as on a change's page.",
    needsShowAll: "Show the needs done or not needed too",
    needsCount: (open: number, changes: number) =>
      `${open} open need${open === 1 ? "" : "s"} across ${changes} open change${changes === 1 ? "" : "s"}`,
    needsNone: "No open needs on any change.",
    needsNoChanges: "No open changes.",
    needsOf: (title: string) => `Needs of ${title}`,
    needsNotYet: (n: number) =>
      `${n} change${n === 1 ? " hasn't" : "s haven't"} been looked at for needs yet`,
    needsCantRead: (change: string, error: string) =>
      `Couldn't read the needs of ${change}: ${error}`,
  },
  // beta.26: the change and work screens in the IDE look (screens/work/cw.tsx).
  changeWork: {
    more: "More",
    less: "Less",
    /**
     * An explanation's More and Less as a screen reader names them, by what they open (the panel,
     * else the explanation's first words), so several on one page are told apart.
     */
    moreAbout: (what: string) => `More: ${what}`,
    lessAbout: (what: string) => `Less: ${what}`,
    /** The All changes list's head: how many changes it holds. */
    changeCount: (n: number) => `${n} change${n === 1 ? "" : "s"}`,
    /** A change's risk as a badge in its head: "Low risk". */
    risk: (level: string) => `${level.charAt(0).toUpperCase()}${level.slice(1)} risk`,
    /** A change's state as its badge, a word for every lifecycle state (core's LIFECYCLE_STATES). */
    lifecycle: {
      draft: "Draft",
      define: "Define",
      design: "Design",
      plan: "Plan",
      build: "Build",
      qa: "QA",
      "release-ready": "Release",
      released: "Released",
      "post-release-review": "Post-release review",
      returned: "Returned",
      archived: "Archived",
    },
    /** A task's terminal fold as a screen reader names it, its task said so each is told apart. */
    fromTerminalFor: (task: string) => `From a terminal or your assistant, for task ${task}`,
    /** A hand-off's PR on a change's chips: short words, the whole address the link's target. */
    prShort: (n?: string) => (n ? `PR #${n}` : "PR"),
  },
  changes: {
    qa: "QA",
    define: "Define",
    design: "Design",
    plan: "Plan",
    build: "Build",
    release: "Release",
    handOffPrOpened:
      "Hand-off raised. Reviewers approve its PR on the Git host (on a manual Git host, its step on Home says how to open it); merging it approves the gate.",
    syncedWithTheGit: "Synced with the Git host.",
    criticRoundStartedThe:
      "The review started: the rule checks ran. Any AI review that waits is in Model runs, where Done checks its answer.",
    theRuleChecksRan: "The rule checks ran. AI is off here, so no AI review waits.",
    checkedTheAnswer: "Checked the answer.",
    readyToTryAgain: "Ready to try again.",
    findAChange: "Find a change",
    idTitleOrRepo: "Id, title or repo",
    state: "State",
    everyState: "Every state",
    blocked: "Blocked",
    blocked2: "BLOCKED",
    noChangeMatches: "No change matches.",
    changes: "Changes",
    acrossAllChanges: "Across all changes",
    noChangesYetStart: "No changes yet. Start one with New change.",
    currentPhase: (v: string | number) => `${v}: current phase`,
    done: "done",
    toCome: "to come",
    phases: "Phases",
    text: (artifact: string | number) => `${artifact} text`,
    save: "Save",
    close: "Close",
    /** Eighth UX walk: an editor with unsaved text offers Cancel, which leaves the file as it was. */
    cancel: "Cancel",
    /** Eighth UX walk: the template's guidance (its comments), shown beside the text. */
    templateAsks: "What the template asks for",
    /** Eighth UX walk: said once the finding has left the list of open ones. */
    recordedOn: (action: string, id: string) => `Recorded on ${id}: ${action}.`,
    ifSomeoneSavedMeanwhile:
      "If someone saved meanwhile, Atticus refuses the save and asks you to reload.",
    edit: (artifact: string | number) => `Edit ${artifact}`,
    saved: (path: string) => `Saved ${path}.`,
    recorded: (action: string) => `Recorded: ${action}.`,
    changedMeanwhile:
      "Someone saved this file meanwhile, so yours wasn't written over theirs. Reload it (your text stays) and save again.",
    reloadKeepMine: "Reload, keep my text",
    taskHanded: (id: string) =>
      `Task ${id} handed to your assistant. Open the prompt, then mark it done.`,
    reason: "Reason",
    reasonNeededToWaive: "Reason (needed to waive or dismiss)",
    applyFix: "Apply fix",
    owner: "owner",
    ask: (v: string | number) => `Ask ${v}`,
    notRelevant: "Not relevant",
    waive: "Waive",
    next: "Next",
    risk: (v: string | number) => `RISK ${v}`,
    handOff: (v: string | number, v2: string | number, v3: string | number) =>
      `${v} HAND-OFF · ${v2}${v3}`,
    /** Sixth UX walk: on a manual Git host, the PR waits on a person to open it. */
    handOffManual: (phase: string) => `${phase} HAND-OFF · WAITS ON A MANUAL STEP`,
    whatBlocksTheHand: "What blocks the hand-off",
    /** UX review: Raise hand-off waits until nothing blocks it, and says why. */
    blockedBy: (n: number) =>
      `${n} thing${n === 1 ? "" : "s"} block${n === 1 ? "s" : ""} the hand-off; clear them first.`,
    raiseHandOff: "Raise hand-off",
    syncAndMergeWhen: "Sync and merge when approved",
    runTheCriticYour: "Run the critic (your assistant)",
    runTheRuleChecks: "Run the rule checks",
    artifact: "Artifact",
    status: "Status",
    findings: "Findings",
    actions: "Actions",
    edit2: "Edit",
    artifacts: "Artifacts",
    checks: "checks",
    noOpenFindingsOn: "No open findings on this change.",
    openFindings: "Open findings",
    done2: "DONE",
    byHand: "BY HAND",
    runWithAi: "Run with AI",
    // ADR 0113: files attached to a change.
    inputs: "Files attached",
    promote: "Copy to general knowledge",
    promoteFor: (path: string) => `Copy ${path} to general knowledge`,
    promoted: (path: string) =>
      `${path} is copied to the metarepo's inputs/inbox/: general knowledge, read at the next sync. This change keeps its copy. Commit both through a pull request.`,
    attachLabel: "Attach a file",
    attachHelp:
      "A spec, screenshot, PDF, email export or document. It is copied into the change's inputs/, and the change's steps read it as data, citing it by line or page.",
    noInputs: "No file is attached yet.",
    attached: (name: string) => `Attached ${name}. The change's steps read it from now on.`,
    attachTooLarge: (mb: number) =>
      `That file is ${mb} MB; the app attaches files up to 15 MB. For a larger one, run atticus change attach in a terminal.`,
    inputFile: "File",
    inputKind: "What it is",
    inputWho: "Attached",
    inputWhen: (by: string, at: string) => `${by}, ${at.slice(0, 10)}`,
    inputRead: (how: string, citeBy?: string) =>
      how === "text" ? `Read, cited by ${citeBy ?? "line"}` : "Not read: open it to see it",
    inputOlder: (by: string) => `Older version: ${by} replaces it`,
    inputHidden: "Hides instructions: kept out of every AI step until a person decides",
    // ADR 0133: a prototype compared with the estate.
    prototypes: "The prototype, compared",
    noPrototypes: (change: string) =>
      `No prototype is attached. Compare one with the estate above, or run: atticus change attach ${change} --prototype <repo>`,
    // Round 36 (UX review): Compare from the app.
    prototypePick: "Prototype repo",
    prototypeCompare: "Compare with the estate",
    prototypeComparing: "Comparing…",
    prototypeCompareHelp:
      "Reads the prototype's verified facts, compares each call with the estate, attaches the comparison to this change and adds what it touches. The same as atticus change attach --prototype.",
    prototypeCompared: (repo: string) => `Compared ${repo} and attached it.`,
    prototypeNoCandidates:
      "No repo in the manifests is typed prototype. Set one repo's type to prototype on Set up › Repos, read it, then compare it here.",
    prototypeMarker: "Prototype",
    prototypeUnconfirmed: "a draft nobody has confirmed",
    prototypeNoAbout: "Nothing says what it is yet.",
    prototypeCounts: (c: { exists: number; changes: number; new: number; vendor: number }) =>
      `${c.exists} exist, ${c.changes} change, ${c.new} new, ${c.vendor} only a vendor provides`,
    prototypeGroup: {
      exists: "Exists",
      changes: "Changes",
      new: "New",
      vendor: "Only a vendor",
    } as Record<"exists" | "changes" | "new" | "vendor", string>,
    prototypeGroupHelp: {
      exists: "The estate serves it as the prototype needs.",
      changes: "The estate serves the operation, but not as the prototype needs.",
      new: "Nothing in the estate serves it.",
      vendor: "Only a vendor provides it, so it needs a route through the external gateway.",
    } as Record<"exists" | "changes" | "new" | "vendor", string>,
    prototypeNoCalls: "None.",
    prototypeGroupCount: (group: string, n: number) => `${group} · ${n}`,
    prototypeLeg: { "ui-bff": "UI to BFF", "bff-mock": "BFF to mock" } as Record<
      "ui-bff" | "bff-mock",
      string
    >,
    prototypeCites: (at: string, lands: string) => `Prototype: ${at} → ${lands}`,
    prototypeEstate: (repo: string, at: string) => `Estate: ${repo} ${at}`,
    prototypeVendor: (name: string, at: string) => `Vendor: ${name} ${at}`,
    /** ADR 0142: the operation is another team's, published in their spec. */
    prototypeTeam: (name: string, at: string) => `Another team: ${name} ${at}`,
    prototypeLeft: (n: number) =>
      `${n} call${n === 1 ? "" : "s"} reach${n === 1 ? "es" : ""} nothing in the prototype and ${n === 1 ? "isn't" : "aren't"} compared.`,
    noTasksYetThey: "No tasks yet: they come with the plan.",
    tasks: "Tasks",
    markDone: "Mark done",
    retry: "Retry",
    /** A hand-off run nobody will finish: cancelled, its task can run again. */
    cancelRun: "Cancel",
    runCancelled: "Cancelled. The task can run again.",
    noAiRunsYet: "No AI runs yet.",
    /** A run that is part of a task run: where the task stands (ADR 0036 addendum, review). */
    taskRunLine: (task: string, state: string, pr?: "open" | "merged" | "closed") =>
      `Task ${task}: ${
        // Eighth UX walk: the PR's state on the Git host now, where the tasks view says it.
        (state === "pr-open" && pr === "merged"
          ? "PR merged"
          : state === "pr-open" && pr === "closed"
            ? "PR closed"
            : undefined) ??
        (
          {
            planned: "planned",
            built: "built",
            unverified: "drafted, not built (no build command)",
            "pr-open": "PR open",
            waiting: "waiting for your assistant",
            "needs-person": "needs a person",
            failed: "failed",
          } as Record<string, string>
        )[state] ??
        state
      }`,
    taskRunLog: (path: string) => `Last build: ${path}`,
    aiRuns: "AI runs",
    pickAChangeOn: "Pick a change on the left, or start one with New change.",
    noChangeSelected: "No change selected",
  },
  commandCenter: {
    /** ADR 0121 item 6: what runs a step here, in one line, beside a link to change it. */
    /** WP7.10: acting on several needs or manual steps at once. */
    select: (title: string) => `Select ${title}`,
    bulkTitle: "Act on the selected items",
    selected: (n: number) => `${n} selected`,
    bulkAction: "What to do",
    bulkNeedDone: (n: number) => `Mark ${n} need${n === 1 ? "" : "s"} done`,
    bulkNeedNot: (n: number) => `Mark ${n} need${n === 1 ? "" : "s"} not needed`,
    bulkStepSkip: (n: number) => `Skip ${n} manual step${n === 1 ? "" : "s"}`,
    bulkTicket: "The ticket or note, for all of them",
    bulkWhy: "Why, for all of them",
    bulkDo: (n: number) => `Do it for ${n}`,
    bulkClear: "Clear the selection",
    bulkDone: (ok: number, failed: number, why: readonly string[] | string = []) =>
      failed
        ? `Done for ${ok}; ${failed} couldn't be changed${why.length ? `: ${[...new Set(typeof why === "string" ? [why] : why)].join("; ")}` : ": open each to see why"}.`
        : `Done for ${ok}.`,
    partlyLoaded: (parts: readonly string[] | string) =>
      `Part of this list didn't load, so it may be short: ${typeof parts === "string" ? parts : parts.join("; ")}`,
    needsOfFailed: (change: string, error: string) => `${change}'s needs (${error})`,
    needsFailed: (error: string) => `the changes' needs (${error})`,
    stepsFailed: (error: string) => `the steps to do (${error})`,
    questionsFailed: (error: string) => `the open questions (${error})`,
    triageFailed: (error: string) => `the triage (${error})`,
    howStepsRun: "How AI steps run:",
    howStepsRunChange: "Change in Set up › AI",
    howStepsRunCantRead: (why: string) => `Atticus couldn't read how AI steps run here: ${why}`,
    define: "Define",
    design: "Design",
    plan: "Plan",
    build: "Build",
    release: "Release",
    theCatalogIsAccepted:
      "The catalog is accepted as the baseline, with your name, in catalog/baseline.yaml. Propose it for review: merging the pull request makes it the baseline on main.",
    baselineAccepted: "Baseline accepted",
    done: " (done)",
    toDo: " (to do)",
    // beta.23: the machine's checks still run; Home doesn't wait for them.
    checking: " (checking)",
    optional: " · optional",
    acceptTheCatalogAs: "Accept the catalog as the baseline",
    afterWalkingTheEcosystem:
      "After walking the ecosystem map with the architect. Every later scan, document and change is compared with it. It is a file in the metarepo, so it reaches main through a pull request.",
    setUpAtticus: "Set up Atticus",
    // Seventh UX walk: the org pack's owner, set here instead of in pack.yaml.
    ownerLabel: "Who looks after the org pack",
    ownerHint:
      "One handle, such as priya.nair or team-platform. Saved as owner in org-pack/pack.yaml: propose it for review; its owner approves changes to the org pack from then on.",
    ownerSave: "Save the owner",
    ownerSaving: "Saving…",
    ownerBad: "One handle: letters, digits, dots and hyphens, no spaces.",
    ownerSaved: (h: string) =>
      `${h} now looks after the org pack. Propose org-pack/pack.yaml for review to share it.`,
    ofDone: (done: string | number, v: string | number) => `${done} of ${v} done`,
    showMyDigest: "Show my digest",
    sendItToMe: "Send it to me",
    // Review round 50: the button names where it posts; the person's yes is for that channel.
    sendItTo: (channel: string | number) => `Send it to ${channel}`,
    sentTo: (channel: string | number) => `Sent to ${channel}.`,
    thingsNeedAttention: (v: string | number) => `${v} things need attention.`,
    nothingIsBlockedRight: "Nothing is blocked right now.",
    approvingIsThePull:
      "Approving is the pull request: each phase ends with a hand-off PR, and merging it approves the gate. Your Git host decides who may approve.",
    currentPhase: (v: string | number) => `${v}: current phase`,
    done2: "done",
    toCome: "to come",
    noChangeInFlight: "No change in flight. Start one with New change.",
    loading: "Loading…",
    couldntLoadWhatNeeds: (why: string) => `Couldn't load what needs a person: ${why}`,
    nothingNeedsAPerson: "Nothing needs a person right now.",
    needsAPerson: "Needs a person",
    // ADR 0105: what waits on you, by kind, each linking to where it is acted on.
    waitingOnYou: "Waiting on you",
    waitQuestions: "Questions to answer",
    waitNeeds: "Needs still open",
    waitSteps: "Manual steps to do",
    waitBlocking: "Blocking findings",
    openNeeds: "Open needs",
    // ADR 0105 addendum: the list of what needs a person, grouped by change.
    byChangeIntro:
      "Grouped by change, changes with something blocking first; then what belongs to no change.",
    noChangeGroup: "Not part of a change",
    blocked: "BLOCKED",
    groupCount: (n: number) => `${n} waiting`,
    inState: (state: string) => `in ${state}`,
    sectionNeeds: "Open needs",
    sectionFindings: "Findings",
    sectionSteps: "Manual steps",
    sectionQuestions: (repo?: string) => (repo ? `Questions · ${repo}` : "Questions"),
    sectionTriage: "To sort out",
    sectionKnowledge: "Knowledge to verify",
    knowledgeToVerify: (n: number) =>
      `${n} knowledge item${n === 1 ? "" : "s"} no one has verified yet`,
    knowledgeDetail: "Verify, correct or reject each against its page",
    aPersonApprovesEvery:
      "A person approves every write · Atticus never touches live systems · every fact keeps its evidence",
    /** beta.26: Home as one screen, a control screen of tiles and short panels. */
    home: {
      you: (user: string, role?: string) =>
        role ? `You are ${user} · ${role}` : `You are ${user}`,
      live: "Live from your metarepo",
      inFlight: "Changes in flight",
      inFlightNone: "None in flight",
      inStage: (n: number, stage: string) => `${n} ${stage}`,
      corrections: "Corrections to apply",
      toPropose: (files: number) =>
        files ? `${files} file${files === 1 ? "" : "s"} to propose` : "Nothing to propose",
      trusted: (trusted: number, all: number) => `${trusted}/${all} trusted`,
      catalog: "Facts in the catalog",
      catalogSub: (interfaces: number, trusted?: string) =>
        `${interfaces} interface${interfaces === 1 ? "" : "s"}${trusted ? ` · ${trusted}` : ""}`,
      mapSub: "Open the map",
      findingsSub: (code: number, ai: number, lens?: string) =>
        `${code} from checks · ${ai} from AI lenses${lens ? ` · most: ${lens}` : ""}`,
      tileLoading: "Loading",
      tileError: (why: string) => `Couldn't load: ${why}`,
      next: "Next for you",
      changes: "Your changes",
      seeAllChanges: "See all changes",
      changesMore: (n: number) => `${n} more in flight`,
      gatesOf: (title: string) => `Gate pipeline of ${title}`,
      glance: "At a glance",
      waitOnYou: "Wait on you",
      waitOnYouSub: (needs: number, steps: number) =>
        `${needs} open need${needs === 1 ? "" : "s"} · ${steps} manual step${steps === 1 ? "" : "s"}`,
      needsMore: (n: number) => `${n} more group${n === 1 ? "" : "s"}`,
      seeAllQuestions: "See all questions",
      wholeList: (n: number) => `Show the whole list (${n})`,
      hideWholeList: "Hide the whole list",
      wholeListTitle: "Everything that needs a person",
      digest: "Digest",
      inChange: (title: string) => `in ${title}`,
      /** The words before a change's name, the name its link (beta.26 review). */
      inChangeLead: "in ",
      assistant: "Use with your assistant",
      problems: "Some files couldn't be read: see Map › Trust.",
      /** Beta.26 review: a short list cut at its top few, the rest one link away. */
      more: (n: number) => `+${n} more`,
      setupLine: (done: number, all: number) =>
        `Atticus isn't set up yet: ${done} of ${all} steps done.`,
      setupShow: "Show the steps",
      count: (n: number, what: string) => `${n} ${what}`,
      topKinds: (list: string) => `Most in the catalog: ${list}`,
      byLens: (list: string) => `Open findings by lens: ${list}`,
      seeFindings: "See the findings",
      seeCatalog: "Explore the catalog",
    },
  },
  explore: {
    evidence: "Evidence",
    noEvidenceRecordedTreat: "No evidence recorded: treat this fact as unconfirmed.",
    whatBreaksIfThis: "What breaks if this changes",
    isOwnedBy: " is owned by ",
    theCatalogDoesntKnow: "The catalog doesn't know who owns ",
    yet: " yet.",
    queryRun: "Query run: ",
    editItBelowTo: " · edit it below to refine",
    ask: (askText: string | number) => `Ask: ${askText}`,
    search: "Search",
    tryDailyLimitKind: 'Try: daily limit · kind:interface via:gateway · "ledger-db"',
    wordsMatchIdsAnd: "Words match ids and names; ",
    kind: "kind:",
    system: "system:",
    status: "status:",
    narrowIt: " narrow it.",
    searchTheCatalog: "Search the catalog",
    searchForAService: "Search for a service, a table, a topic, a term or a feature.",
    searchResults: "Search results",
    nothingMatchesTryFewer: "Nothing matches. Try fewer words.",
    results: "Results",
    theCatalogIsEmpty:
      "The catalog is empty. Read a repo first: your assistant reads its code, and Atticus checks each fact against its line and draws the map.",
    around: (focusId: string | number) => `Around ${focusId}`,
    theWholeEstate: "The whole estate",
  },
  knowCommon: {
    table: "Table",
  },
  design: {
    interfaces: "Interfaces",
    tables: "Tables",
    result: "Result",
    what: "What",
    next: "Next",
    diagramLabel: "Diagram label",
    matched: "Matched",
    how: "How",
    similar: "Similar",
    context: "Context",
    data: "Data",
    events: "Events",
    container: "Container",
    sequence: "Sequence",
    item: "Item",
    party: "Party",
    due: "Due",
    forecast2: "Forecast",
    status: "Status",
    commitment: "Commitment",
    neededBy: "Needed by",
    noInTheCatalog: (v: string | number) => `No ${v} in the catalog.`,
    evidence: "Evidence",
    noEvidenceTreatIt: "No evidence: treat it as unconfirmed.",
    // The path of a call through the gateways (ADR 0124 addendum A-gateway2).
    thePathOfTheCall: "The path of the call",
    scopesIt: (scopes: string) => `scopes ${scopes}`,
    noScopeDemanded: "no scope demanded",
    theCallerMeets: (auth: string) => `the caller meets ${auth}`,
    thenReaches: (to: string) => `then reaches ${to}`,
    noRouteRecordedFor:
      "The catalog has no gateway route for this call: only that it goes through a gateway.",
    consumersAndDependants: "Consumers and dependants",
    seeImpact: "See impact",
    nothingInTheCatalog: "Nothing in the catalog depends on it.",
    record: "Record",
    apis: "APIs",
    interfacesAndEvents: "Interfaces and events",
    dataStores: "Data stores",
    dataStoresComeFrom:
      "Data stores come from DDL, migrations, ORM mappings and DBA exports, never live databases.",
    contractsList: "Contracts list",
    contracts: "Contracts",
    chooseAnApiAn:
      "Choose an API, an interface or a table to see its evidence and who depends on it.",
    pickAContract: "Pick a contract",
    contractsByKind: "Contracts by kind",
    contractMix: "Contract mix",
    ofInterfacesVerifiedFrom: (verified: string | number, total: string | number) =>
      `${verified} of ${total} interfaces verified from code`,
    /** A long list shows a page; a filter finds the rest (review round 31). */
    filterContracts: (kind: string) => `Find ${kind} by id or name`,
    showingOf: (shown: number, total: number) => `Showing ${shown} of ${total}`,
    showMore: "Show more",
    aVendorSpecIs:
      "A vendor spec is a document until its caller is scanned; code wins when they differ.",
    fieldMappings: "Field mappings",
    verifiedFromCode: "Verified from code",
    noDiagramsYetPut: "No diagrams yet. Put draw.io, Visio, Lucid CSV or Mermaid files under ",
    inputsDiagrams: "inputs/diagrams/",
    orAddThemOn: " (or add them on ",
    intake: "Intake",
    thenComeBack: "), then come back.",
    reconcileADiagramAgainst: "Reconcile a diagram against the catalog",
    edgesMatchCode: (v: string | number, edges: string | number) =>
      `${v}/${edges} edges match code`,
    toResolve: (v: string | number) => `${v} TO RESOLVE`,
    inSync: "IN SYNC",
    checkAgain: "Check again",
    ofDrawnEdgesAgree: (v: string | number, edges: string | number) =>
      `${v} of ${edges} drawn edges agree with code`,
    drawnEdgesAgreeWith: "drawn edges agree with the code",
    itemsToResolveBy: "Items to resolve by kind",
    labelsMatchedToThe: (v: string | number, v2: string | number) =>
      `${v}/${v2} labels matched to the catalog`,
    noDiagramsCouldBe: "No diagrams could be read.",
    diagrams: "Diagrams",
    pickADiagram: "Pick a diagram.",
    all: (v: string | number) => `All ${v}`,
    filterItems: "Filter items",
    everyDrawnEdgeAgrees: "Every drawn edge agrees with the code.",
    itemsToResolve: "Items to resolve",
    codeWinsOverA: "Code wins over a diagram: a conflict goes to ",
    triage: "triage",
    untilAPersonDecides: " until a person decides.",
    edgeByEdge: (v: string | number) => `Edge by edge · ${v}`,
    edgeByEdge2: "Edge by edge",
    ofEdgesAgreeWith: (v: string | number, edges: string | number) =>
      `${v} of ${edges} edges agree with code`,
    diagramLabels: "Diagram labels",
    noMatch: "NO MATCH",
    confirmANameWith: "Confirm a name with ",
    atticusAliasLabelId: 'atticus alias "<label>" <id>',
    itIsSavedTo: "; it is saved to the alias table.",
    nameMatching: "Name matching",
    view: "View",
    system: "System",
    drawnFromTheCatalog:
      "Drawn from the catalog; rebuilt whenever it changes. Edits happen in draw.io and come back through the metarepo.",
    generatedViews: "Generated views",
    noSystemToDraw:
      "This view is drawn around one system, and the catalog has none yet: read a repo first, then come back.",
    systemsFailed: (error: string) => `The systems couldn't be listed: ${error}`,
    nothingToDrawThe: (v: string | number) =>
      `Nothing to draw: the catalog has nothing for the ${v} view.`,
    theCatalogIsEmpty:
      "The catalog is empty. Read a repo first: your assistant reads its code, and Atticus checks each fact against its line and draws the map.",
    view2: (label: string | number) => `${label} view`,
    mermaidSource: "Mermaid source",
    nothingToDrawFor: "Nothing to draw for this view yet.",
    mermaid: "Mermaid",
    copied: "Copied",
    copy: "Copy",
    diagramsUnder: "Diagrams under ",
    areComparedWithThe: " are compared with the catalog on ",
    reconcile: "Reconcile",
    diagramsInTheMetarepo: "Diagrams in the metarepo",
    writeTheDrawIo: "Write the draw.io shape library with ",
    atticusDiagramLibraryFile: "atticus diagram library <file>",
    andLoadItIn:
      " and load it in draw.io, or in the draw.io integration for IntelliJ or VS Code: boxes keep their catalog ids.",
    catalogShapeLibrary: "Catalog shape library",
    nothingPlannedYet: "Nothing planned yet.",
    today: (today: string | number) => `today ${today}`,
    target: (targetRelease: string | number) => `target ${targetRelease}`,
    timelineOfPlanItems: (
      itemsLength: string | number,
      start: string | number,
      today: string | number,
    ) => `Timeline of ${itemsLength} plan items from ${start}; today ${today}`,
    changesParties: (journey: string | number, v: string | number, size: string | number) =>
      `${journey} · ${v} changes · ${size} parties`,
    noInitiativesYet: "No initiatives yet. Start one from a guided journey with New initiative.",
    startOneFromA: "Or in a terminal: ",
    atticusInitiativeNewTitle: 'atticus initiative new "<title>" --journey new-feature',
    initiatives: "Initiatives",
    /** UX review: initiatives start, are planned and have their commitments recorded here. */
    newInitiative: "New initiative",
    newInitiativeTitle: "New initiative",
    initiativeTitleLabel: "Title",
    initiativeTitleHint: "Northwind Pay v3 migration",
    initiativeIdLabel: "Id (from the title)",
    journeyLabel: "Guided journey",
    journeys: {
      "new-feature": "New feature",
      "new-integration": "New integration",
      "vendor-api-change": "Vendor API change",
      "design-change": "Design change",
      migration: "Migration",
      "retire-system": "Retire a system",
    } as Record<string, string>,
    releaseLabel: "Target release (optional)",
    epicLabel: "Work-tracker epic (optional)",
    startInitiative: "Start the initiative",
    startingInitiative: "Starting…",
    startedInitiative: (id: string) => `Started ${id}. Plan it next: name the system it is about.`,
    /** Seventh UX walk: an initiative's status in words. */
    initiativeStates: {
      "not-planned": "Not planned yet",
      "on-track": "On track",
      "at-risk": "At risk",
      slipped: "Slipped",
      done: "Done",
      open: "Open",
    } as Record<string, string>,
    noPlanYet: "No plan yet: name the system it is about below and press Plan it.",
    changesToStart: "Changes to start",
    noChangesYet: "No changes yet: planning it writes the changes to start.",
    notStartedYet: "not started yet",
    cancel: "Cancel",
    planTitle: "Plan its changes and commitments",
    planSay:
      "Atticus works back from the release through the journey's steps, with each team's and vendor's lead times, and writes the changes to start and who owes what.",
    targetLabel: "System it is about",
    targetHint: "northwind-pay",
    planReleaseLabel: "Target release",
    systemsLabel: "Other systems it touches (optional, comma-separated)",
    plan: "Plan it",
    replan: "Plan it again",
    planning: "Planning…",
    planned: "Planned. The changes to start, the plan items and who owes what are on this page.",
    setCommitment: (what: string) => `Record where "${what}" stands`,
    commitmentStateLabel: "State",
    commitmentStates: {
      open: "Open",
      "at-risk": "At risk",
      done: "Done",
      slipped: "Slipped",
    } as Record<string, string>,
    noteLabel: "Note (optional): what changed, who said so",
    recordState: "Record it",
    recording: "Recording…",
    recorded: (id: string, state: string) => `Recorded: ${id} is ${state}.`,
    lastNote: (note: string, by: string, at: string) => `“${note}” (${by}, ${at.slice(0, 10)})`,
    update: "Update",
    orCommand: "Or: ",
    commitCommand: (id: string) => `atticus initiative commit ${id} <open|at-risk|done|slipped>`,
    criticalPath: "Critical path",
    planItems: "Plan items",
    forecast: (projectedRelease: string | number) => ` · forecast ${projectedRelease}`,
    target2: (targetRelease: string | number, v: string | number) => `Target ${targetRelease}${v}`,
    timeline: "Timeline",
    noCommitmentsYet: "No commitments yet.",
    commitments: "Commitments",
    whoOwesWhat: "Who owes what",
  },
  know: {
    decided: (label: string) => `Decided: ${label}.`,
    started: (label: string) => `${label} started.`,
    verifiedFromCode: "verified from code",
    fromDocumentsOnly: "from documents only",
    coverageBySystemAnd2: "Coverage by system and area",
    component: "Component",
    record: "Record",
    kind: "Kind",
    why: "Why",
    owner: "Owner",
    confirmedByPeople: "Confirmed by people",
    foundInCodeOnly: "Found in code only",
    unknown2: "Unknown",
    code: "Code",
    pattern: "Pattern",
    interaction: "Interaction",
    route: "Route",
    target: "Target",
    term: "Term",
    definition: "Definition",
    file: "File",
    readAs: "Read as",
    about: "About",
    facts: "Facts",
    status: "Status",
    sync: "Sync",
    scan2: "Scan",
    repo: "Repo",
    platform: "Platform",
    type: "Type",
    baseClone: "Base clone",
    guideTo: (system: string | number) => `Guide to ${system}`,
    guide: (system: string | number) => `Guide · ${system}`,
    generatedFromTheCatalog: "Generated from the catalog",
    theCatalogIsEmpty:
      "The catalog is empty. Read a repo first: your assistant reads its code, and Atticus checks each fact against its line and draws the map.",
    around: (focus: string | number) => `Around ${focus}`,
    ecosystemMap: "Ecosystem map",
    showAll: "Show all",
    clickANodeTo: "Click a node to centre it",
    gaps: (gaps: string | number) => ` · ${gaps} gaps`,
    verified: (verified: string | number, total: string | number, v: string | number) =>
      `${verified}/${total} verified${v}`,
    factsVerifiedFromCode: (system: string | number) => `${system}: facts verified from code`,
    noSystemsYet: "No systems yet.",
    systems: "Systems",
    coverageBySystemAnd: "Coverage by system and area",
    notExpected: "not expected",
    notExpected2: (system: string | number, name: string | number) =>
      `${system} · ${name}: not expected`,
    whatTheCatalogKnows: "What the catalog knows",
    /** No System record yet (a catalog read from facts, ADR 0124): what each repo's facts say. */
    factsByRepo: {
      intro:
        "No System record says more yet, so this is what each repo's verified facts say. Map › Trust says how far to trust them.",
      caption: "Facts by repo",
      repo: "Repo",
      entries: "Entries",
      tables: "Tables",
      calls: "Calls",
      flows: "Flows",
      none: "No repo has facts yet: read one first, and its facts are counted here.",
      cantRead: (repo: string) => `${repo}'s facts couldn't be read.`,
    },
    ask: (owner: string | number) => ` · ask ${owner}`,
    ownerUnknown: " · owner unknown",
    questionsForOwners: "Questions for owners",
    noOpenQuestionsEvery: "No open questions: every gap has an answer.",
    recordId: "Record id",
    aComponentInterfaceTable:
      "A component, interface, table, column or topic id, e.g. ledger-db.account",
    showImpact: "Show impact",
    incidentModeOn: "Incident mode on",
    incidentMode: "Incident mode",
    findAnIdIn: "Find an id in the Knowledge explorer",
    whatBreaksIfThis: "What breaks if this changes",
    noOwnerRecordedFor: (v: string | number) => `No owner recorded for ${v}.`,
    fromTheLastScan:
      "From the catalog. Atticus never connects to live systems, consoles or monitoring.",
    ownersToCall: "Owners to call",
    noAlertsDashboardsOr: "No alerts, dashboards or runbooks in the catalog for what it reaches.",
    whatWatchesIt: "What watches it",
    noChangeTouchesWhat: "No change touches what it reaches.",
    recentNearbyChanges: "Recent nearby changes",
    nothingDependsOnIt: "Nothing depends on it.",
    blastRadiusOf: (q: string | number) => `Blast radius of ${q}`,
    recordsAffectedBy: (root: string | number) => `Records affected by ${root}`,
    hop: (hop: string | number, v: string | number) => `${hop} hop${v}`,
    recordsHopsAway: (n: string | number, hop: string | number) => `${n} records ${hop} hops away`,
    blastRadius: "Blast radius",
    affectedRecords: "Affected records",
    unknown: "UNKNOWN",
    nothingDependsOnIt2: "Nothing depends on it in the catalog.",
    affected: "Affected",
    noGapsTheCatalog: "No gaps: the catalog knows every hop.",
    readOnlyAtticusNever:
      "Read-only. Atticus never connects to live systems; this is the catalog's view.",
    whatWouldSharpenThis: "What would sharpen this",
    featuresByHowThey: "Features by how they were named",
    entryPoints: (v: string | number) => `${v} entry points`,
    features: "Features",
    noFeaturesFoundYet: "No features found yet. Read the repos first.",
    featuresFoundInCode: "Features found in code",
    pickAFeature: "Pick a feature.",
    noWorkItemsLinked: "NO WORK ITEMS LINKED",
    item: "item",
    entryPoints2: "Entry points",
    recordsInTheFlow: (v: string | number) => `Records in the flow (${v})`,
    knowledgeGaps: "Knowledge gaps",
    noneEveryHopIs: "None: every hop is known.",
    nameTagOrLink: "Name, tag or link it with ",
    atticusFeatureName: (id: string | number) => `atticus feature name ${id} …`,
    featureTag: "feature tag",
    or: " or ",
    featureLink: "feature link",
    theChangeGoesIn: ": the change goes in by PR.",
    feature: "Feature",
    problems: (v: string | number, v2: string | number) => `${v} problems: ${v2}`,
    valid: "VALID",
    usingBuiltInDefaults: (v: string | number) => `Using built-in defaults for ${v}.`,
    orgPack: "Org pack",
    integrationPatterns: "Integration patterns",
    noPatternsYet: "No patterns yet.",
    rulesV: (rules: string | number, version: string | number) => `${rules} rules · v${version}`,
    steps: (steps: string | number) => `${steps} steps`,
    checklistsAndProcedures: "Checklists and procedures",
    glossary: "Glossary",
    needsADefinition: "NEEDS A DEFINITION",
    noTermsYet: "No terms yet.",
    filesInInputs: "files in inputs/",
    files: "Files",
    factsTaken: "Facts taken",
    filesByStatus: "Files by status",
    nothingYet: "Nothing yet.",
    whatHappenedToThem: "What happened to them",
    nothingHiddenOrAimed:
      "Nothing hidden or aimed at an AI reader. Ingested content is data, never instructions.",
    defences: "Defences",
    filesReadFromInputs: "Files read from inputs/",
    noSystemNamed: "no system named",
    quarantined: "QUARANTINED",
    nothingInInputsYet:
      "Nothing in inputs/ yet. Drop diagrams, documents, API specs and exports there (Add files on Knowledge › Documents, or atticus intake add <file>).",
    intake: "Intake",
    inputs: "inputs/",
    eachChoiceIsSaved:
      "Each choice is saved as a curated decision in your name. Code always wins over a document until a person decides.",
    nothingToTriage: "Nothing to triage.",
    needsYou: "Needs you",
    ofReposCloned: (present: string | number, total: string | number) =>
      `${present} of ${total} repos cloned`,
    reposClonedLocally: "repos cloned locally",
    syncRepos: "Sync repos",
    /** App-only audit: the old built-in readers are a cross-check, never how the map is made. */
    scanNow: "Check with the built-in readers",
    scanCrossCheck:
      "A cross-check, not how the map is made: the built-in readers read every repo's files. A scan keeps each repo read in full as its readers slot, keeps every other repo's last good read and says why, then builds the catalog; for a repo with verified facts, the facts stay its map and the readers' differences are listed under Readers found / facts say. It asks which repo answers on an unknown host only for the repos your assistant has read.",
    /** Beta.26 safety stop: a scan that didn't read every repo in full wrote nothing. */
    scanRefusedTitle: "Nothing written: the catalog is as it was.",
    scanRefusedState: "Nothing written",
    scanRefusedList: "Repos the scan didn't read in full",
    scanRefusedWhy: {
      "not-cloned": (repo: string) => `${repo}: not cloned here. Sync repos, then check again.`,
      unreadable: (repo: string) =>
        `${repo}: its clone can't be read. Sync repos to clone it again.`,
      "not-asked": (repo: string) =>
        `${repo}: left out of this scan, and a scan of some repos would replace the catalog with them alone.`,
    } as Record<string, (repo: string) => string>,
    scanRefusedRun: (repo: string, runs: string) =>
      `${repo}: ${runs}, so its read is short of what that run reads.`,
    scanRefusedRunOne: (extractor: string, error: string) =>
      `the run of ${extractor} failed (${error})`,
    scanRefusedEmpty: (before: number) =>
      `The scan found no records in any repo's code, and the catalog has ${before}.`,
    scanRefusedTodo:
      "Sync repos, then check again, or put one repo's read in the catalog from its facts: atticus verify <repo> --write (Map › Trust). A failed reader run is in the Console.",
    scanAskAll: "Also ask about the repos your assistant hasn't read",
    scanAdded: (added: number, changed: number, removed: number, questions: number) =>
      `The built-in readers added ${added} ${added === 1 ? "record" : "records"}, changed ${changed} and removed ${removed}. ${questions === 1 ? "1 host question is" : `${questions} host questions are`} open.`,
    readAgain: "Read again with your assistant",
    readAgainWhere: "Your assistant reads each repo and cites its facts: on Map › Trust.",
    jobProgress: "Job progress",
    /** A job's state in words (ADR 0119). */
    jobState: {
      queued: "Waiting to start",
      running: "Running",
      done: "Done",
      failed: "It stopped with problems",
      cancelled: "Cancelled: it stopped before writing anything more",
    } as Record<string, string>,
    cancelJob: "Cancel",
    cancelling: "Stopping…",
    cancelJobHint: "Stops at the next repo; what was already written stays.",
    jobProblems: "What went wrong",
    scansReadFilesOnly: "Scans read files only: no network, no AI.",
    scan: "Scan",
    repos: "Repos",
    cloned: "CLONED",
    notYet: "NOT YET",
    noReposInAny: "No repos in any manifest yet.",
    noFactsYet: "No facts yet.",
    catalog: "Catalog",
  },
  phase: {
    runPrepared: (runId: string) => `Run ${runId} prepared: your assistant takes it from here.`,
    openTheRun: "Open the run: its prompt, Done and Cancel",
    /** Ninth UX walk: what a task waits for; its own repo's tasks say so. */
    waitsForTasks: (tasks: string) => `Waits for ${tasks}`,
    sameRepo: (id: string) => `${id} (same repo)`,
    theRuleChecksRan:
      "The rule checks ran; any AI review is with your assistant. Each waits in Model runs, where Done checks its answer.",
    theRuleChecksRan2: "The rule checks ran. AI is off here, so no AI review waits.",
    handOffPrRaised:
      "Hand-off raised. A person approves and merges its PR on the Git host (on a manual Git host, its step on Home says how to open it).",
    blockedBy: (n: number) =>
      `${n} thing${n === 1 ? "" : "s"} block${n === 1 ? "s" : ""} the hand-off; clear them first.`,
    syncedWithTheHand: "Synced with the hand-off PR.",
    sourceField: "Source field",
    targetField: "Target field",
    rule: "Rule",
    whenMissingOrInvalid: "When missing or invalid",
    transform: "Transform",
    record: "Record",
    theStoryWritersPrompt: "The story writer's prompt is ready for your assistant.",
    requirement: "Requirement",
    story2: "Story",
    test: "Test",
    code: "Code",
    gap: "Gap",
    what: "What",
    handOff: (phase: string | number, state: string | number) => ` · hand-off ${phase} ${state}`,
    approvalMerge: "Approval: merge ",
    pr: (number: string | number) => `PR #${number}`,
    onTheGitHost: " on the Git host; that approves the gate.",
    approvalRaiseTheHand: "Approval: raise the hand-off; merging its PR approves the gate.",
    runTheCritic: "Run the critic",
    runTheRuleChecks: "Run the rule checks",
    raiseHandOff: "Raise hand-off",
    syncAndMergeWhen: "Sync and merge when approved",
    gate: "Gate",
    notWrittenYetEdit:
      "Not written yet. Edit writes it, or your assistant drafts it with the change's other files:",
    notWrittenYetFor:
      "Not written yet for this change. It is drafted when the change reaches this phase, or by its agent.",
    /** An Atticus 1 artifact on an Atticus 2 change (2026-10-25). */
    noSuchArtifact: (artifact: string) =>
      `This change has no ${artifact}. Atticus 2 writes a change's brief, design, stories and tasks in its stages instead: see Feature design, Architecture and Stories.`,
    text: (artifact: string | number) => `${artifact} text`,
    edit: "Edit",
    for: (owner: string | number) => ` for ${owner}`,
    question: (v: string | number, text: string | number) => `Question${v}: ${text}`,
    noOpenFindingsOn: "No open findings on this. Run the critic to check it.",
    criticFindings: "Critic findings",
    open: (mineLength: string | number) => `${mineLength} open`,
    featureBrief: "Brief",
    prototypesAndUx: "Prototypes and UX",
    attachADesignExport:
      "Attach a design export (frames as images or PDF, or a prototype link file) below: it goes into the change's ",
    inputs: "inputs/",
    intake: "Intake",
    screenAtticusReadsThe:
      ". Atticus reads the screens and states as data, drafts requirements from them into the UX artifact, and the UX lens checks loading, empty, error and done states and WCAG 2.1 AA contrast. A prototype repo is compared with the estate below.",
    bringInAPrototype: "Bring in a prototype",
    repoPlansCompared: (v: string | number) => `${v} repo plans compared`,
    noRepoPlansYet: "No repo plans yet: design compared with code",
    inSync: "IN SYNC",
    designVsPlansVs: "Design vs plans vs code",
    architectureReview: "Architecture review",
    everyHopInDesign:
      "Every hop in design.md carries a pattern code; the critic checks each against the code. Code wins over a diagram; conflicts go to triage.",
    theOrgPackHas: "The org pack has no patterns yet.",
    integrationPatterns: "Integration patterns",
    orgPack: "Org pack",
    vendorSpecsWhiteboardPhotos: "Vendor specs, whiteboard photos and standards go in through ",
    diagramsAreComparedEdge: "; diagrams are compared edge by edge on ",
    reconcile: "Reconcile",
    ingestedContentIsData: ". Ingested content is data, never instructions.",
    yourMaterial: "Your material",
    noMappingChange: "NO MAPPING CHANGE",
    fields: (v: string | number) => `${v} FIELDS`,
    fieldMappingsFor: (heading: string | number) => `Field mappings for ${heading}`,
    noFieldRowsYet: "No field rows yet for this hop.",
    mappedTodayInThe: (v: string | number) => `Mapped today in the catalog · ${v}`,
    catalogFieldMappingsFor: (heading: string | number) => `Catalog field mappings for ${heading}`,
    theCatalogHasNo: "The catalog has no field mappings yet, so there is nothing to compare with.",
    noHopsInMappings:
      "No hops yet. A change taken through the stages gets these from its target flows, in Architecture; a change with a mappings.md gets them from there \u2014 a section per hop: source field, target field, rule, and what happens when it is missing.",
    /** Where a hop's rows were read from: mappings.md, or the architecture stage's target flow (ADR 0129). */
    readFromMappingsFile: "from mappings.md",
    readFromTargetFlow: (flow: string) => `from the target flow ${flow}`,
    fieldMappings: "Field mappings",
    byHopWithThe: "by hop, with the catalog",
    apiMappings: "API mappings",
    eachHopsSourceField:
      "Each hop's source field, transform and target field are checked against the catalog's columns and schemas: a required target with no source, a narrowing type (80 to 40 characters) or personal data leaving the estate is a finding. Tests generated from the stories trace back to these rows on ",
    testTrace: "Test trace",
    howMappingsAreChecked: "How mappings are checked",
    ofStoriesReady: (passed: string | number, total: string | number) =>
      `${passed} of ${total} stories ready`,
    barMet: "BAR MET",
    needs: (v: string | number) => `NEEDS ${v}%`,
    noStoryCovers: (what: string | number) => `No story covers: ${what}`,
    noStoriesYetWrite: "No stories yet. The stories stage writes them from the approved design.",
    /** Eighth UX walk: one path to write stories, the stories stage; Breakdown links to it. */
    storiesAtTheStage:
      "Stories and tasks are written at the stories stage: Prepare on its tab runs it with your assistant, and the critic checks each draft. You edit them there before the plan gate.",
    storiesStageDone:
      "The stories stage is done. Read and edit the stories on its tab; it offers Run again if they need redrafting.",
    openStoriesStage: "Open the stories stage",
    /** Eighth UX walk: a task's PR, recorded or waiting on a person to open it. */
    taskPrToOpen: "PR TO OPEN",
    taskPrOpenChip: (n: number) => `PR #${n} OPEN`,
    taskPrWaitsOnYou: "Its PR waits on you to open it on the Git host, a step in",
    markedDoneBy: (who: string, day: string) =>
      `Marked done by ${who}${day ? ` on ${day}` : ""}. The tick rides the change's build hand-off.`,
    markedNotDoneBy: (who: string, day: string) =>
      `Marked not done by ${who}${day ? ` on ${day}` : ""}.`,
    noCodeYet: "NO CODE YET",
    noCodeYetWhy: "No task has run yet, so there is no code to compare with the design and plans.",
    storyBar: "Story bar",
    theStoryWriterDrafts:
      "The story writer drafts stories, acceptance criteria and repo tasks from the approved design. You edit them before the plan gate.",
    writeStoriesWithAi: "Write stories with AI",
    storiesAndTasks: "Stories and tasks",
    breakdown: "Breakdown",
    done: (done: string | number, mineLength: string | number) => `${done}/${mineLength} done`,
    ofTasksDone: (r: string | number, done: string | number, mineLength: string | number) =>
      `${r}: ${done} of ${mineLength} tasks done`,
    done2: "DONE",
    runWithAi: "Run with AI",
    byHand: "BY HAND",
    story: (story: string | number) => ` · story ${story}`,
    noTasksYetThey: "No tasks yet: they come from tasks.md once the stories are written.",
    handDownPreview: "Hand-down preview",
    tasksByRepo: "Tasks by repo",
    tasks: (v: string | number) => `${v} tasks`,
    ofRunsFinished: (passed: string | number, rLength: string | number) =>
      `${passed} of ${rLength} runs finished`,
    everyWriteIsApproved:
      "Every write is approved by a person; AI never pushes to protected branches.",
    noRunsYet: "No runs yet.",
    aiTaskRuns: "AI task runs",
    /** Sixth UX walk: the panel counts task runs only, not the critics' and stages' runs. */
    noTaskRunsYet: "No task has run with AI yet: Run with AI on a task starts one.",
    /** Sixth UX walk: where a task's Run with AI stands, after its draft. */
    taskState: {
      built: "DRAFTED",
      unverified: "UNVERIFIED",
      "pr-open": "PR RAISED",
      waiting: "WITH YOUR ASSISTANT",
      "needs-person": "NEEDS A PERSON",
      failed: "STOPPED",
      planned: "PLANNED",
    } as Record<string, string>,
    taskBuilt: (branch: string, commit: string) =>
      `Drafted and built: committed on ${branch} (${commit.slice(0, 7)}). Its PR is the next step.`,
    taskUnverified: (repo: string, branch: string, base: string) =>
      `Drafted and committed on ${branch}, but ${repo} has no build command, so nothing was built or tested. Atticus opens a task's PR only after a passing build: set ${repo}'s build command on Set up › Repos, then Build and raise PR here; or push ${branch} and open its PR into ${base} yourself.`,
    /** App-only audit: the card says the build command set since, from the state now. */
    taskUnverifiedBuildable: (repo: string, branch: string) =>
      `Drafted and committed on ${branch}, not built yet. ${repo} has a build command now: Build and raise PR builds it and, on your yes, raises its PR. Run again drafts it afresh.`,
    /** A person took the task over: once their work is committed, Build and raise PR carries on. */
    taskNeedsPersonBuild: (branch: string) =>
      `Once your fix is committed on ${branch}, Build and raise PR builds it and raises its PR.`,
    /** App-only audit: a hand-off branch whose push failed is kept here; Push again sends it. */
    handoffUnpushed: (branch: string) =>
      `The hand-off's branch ${branch} is here but wasn't pushed, so its PR has no files on the Git host yet.`,
    pushAgain: "Push again",
    pushingAgain: "Pushing…",
    pushAgainWhy: "Your click is your approval to push the branch (never forced).",
    handoffPushed: (branch: string) => `Pushed ${branch}.`,
    buildAndRaise: "Build and raise PR",
    buildingTask: "Building…",
    buildAndRaiseWhy:
      "Builds the task where it was drafted; your click is your approval to push its branch and open its PR once the build passes.",
    taskBuiltAndRaised: (task: string) =>
      `Task ${task} is built and its PR is raised into the change branch. A person reviews and merges it on the Git host.`,
    taskBuiltOnly: (task: string) =>
      `Task ${task} is built. Its PR is the next step: Raise the task's PR.`,
    /** App-only audit: Mark done on a task whose code isn't in the change branch yet. */
    taskUnmerged: (branch: string, n: number, base: string) =>
      `Its branch ${branch} has ${n === 1 ? "a commit" : `${n} commits`} not in ${base}, so its code isn't in the change yet: raise its PR and merge it. Build ready and the release wait for that.`,
    taskDecided: (by: string, at: string, reason: string) =>
      `${by} let its work go on ${at}: "${reason}"`,
    markDoneAnyway: "Mark done anyway",
    markDoneReason: "Why isn't its work needed?",
    markDoneReasonHelp:
      "Recorded with your name. Build ready and the release then go without this task's commits.",
    markDoneNeedsReason: "Say why its work isn't needed first.",
    taskWaiting: "Your assistant has it: Done on its run checks the work.",
    taskPrOpen: "Its PR is open:",
    /** Review round 43: the Git host says the task's PR is merged or closed. */
    taskPrStateChip: { merged: "PR MERGED", closed: "PR CLOSED" } as Record<string, string>,
    taskPrMerged:
      "Its PR is merged into the change branch. Mark the task done, or Run with AI again to start it over:",
    /** Seventh UX walk: tick or untick a task in tasks.md from the Task board. */
    tickTask: "Mark done",
    untickTask: "Mark not done",
    tickTaskLabel: (task: string) => `Mark task ${task} done`,
    untickTaskLabel: (task: string) => `Mark task ${task} not done`,
    tickedTask: (task: string) =>
      `Ticked task ${task} in tasks.md. The tick rides the change's build hand-off.`,
    untickedTask: (task: string) =>
      `Unticked task ${task} in tasks.md. That rides the change's build hand-off too.`,
    /** Seventh UX walk: Atticus ticked the task because the Git host says its PR merged. */
    tickedByMerge:
      "Atticus ticked it in tasks.md when its PR merged on the Git host. The tick rides the change's build hand-off.",
    taskPrClosed:
      "Its PR was closed without merging. Run with AI again to start the task over, or do it by hand:",
    taskPrNumber: (n: number) => `PR #${n}`,
    raiseTaskPr: "Raise the task's PR",
    raisingTaskPr: "Raising the PR…",
    raiseTaskPrWhy: "Your click is your approval to push the task's branch and open its PR.",
    /** Review round 42: the push or the Git host failed; the build stands, so it is raised again. */
    taskPrNotRaised:
      "Its PR wasn't raised. The build still passes: raise it again once this is fixed.",
    taskPrRaised: (task: string) =>
      `Task ${task}'s PR is raised into the change branch. A person reviews and merges it on the Git host.`,
    taskPrManual: (task: string) =>
      `Task ${task}'s PR is a step for you now: open it on the Git host, then record its link.`,
    openItsRun: "Open its run",
    runAgainWithAi: "Run with AI again",
    /** Sixth UX walk: a manual Git host's PR isn't open until a person opens it. */
    manualPrWaits: "Opening this PR is a step waiting on you, in",
    manualSteps: "Home › Manual steps",
    handOffWaitsManual: (phase: string) =>
      `The ${phase} hand-off's PR isn't open yet: your Git host is manual, so opening it is a step waiting on you. Open it on the Git host as its step says and record its link there; once it is merged on the Git host, record that on its reviews step. Atticus syncs the change each time you mark one done, and merging approves the gate.`,
    handOffManual: (phase: string) => ` · hand-off ${phase} waits on a manual step`,
    taskBoard: "Task board",
    tasksInCrossRepo:
      "Tasks in cross-repo order. The tech lead or architect runs the tasks: Run all ready tasks runs every task whose dependencies are done, and Run with AI runs one. Atticus hands the Spec Kit feature down to the repo, prepares the prompt for your assistant and reads the result back at the PR.",
    everyRequirementShouldReach:
      "Every requirement should reach a story, a test, code and a release. Gaps are flagged before QA sign-off.",
    requirementToCode: "Requirement to code",
    noRequirement: "NO REQUIREMENT",
    noStory: "NO STORY",
    noTest: "NO TEST",
    nothingToTraceYet: "Nothing to trace yet: the change has no requirements with scenarios.",
    traceGaps: "Trace gaps",
    noGapsEveryRequirement: "No gaps: every requirement reaches a story and a test.",
    gapsBeforeQaSign: "Gaps before QA sign-off",
    ofRowsHaveA: (covered: string | number, total: string | number) =>
      `${covered} of ${total} rows have a test`,
    ofTracedToA: (covered: string | number, total: string | number) =>
      `${covered} of ${total} traced to a test`,
    gapsByKind: "Gaps by kind",
    scenarioCoverage: "Scenario coverage",
    theTestStrategyAsks: "The test strategy asks for nothing extra here.",
    requiredKindsComeFrom:
      "Required kinds come from the change type and risk in the org pack's test strategy. Tests are generated from story scenarios, then reviewed by a person.",
    testKindsThisChange: "Test kinds this change needs",
  },
  notBuilt: {
    thisScreenIsBeing:
      "This screen is being built. Everything it will show is already available from the command line: run ",
    atticusHelp: "atticus --help",
    toFindTheCommand: " to find the command.",
  },
  evals: {
    runFinished: (runId: string, failed: string | undefined) =>
      `Eval run ${runId} finished: ${failed ?? ""}.`,
    casesFailed: (n: string) => `${n} failed`,
    actedOn: (applied: number, resolved: number) => `${applied} of ${resolved} acted on`,
    quarantinedNeverSentTo: "quarantined, never sent to a model",
    everyCasePassed: "every case passed",
    noFindingsResolvedYet: "no findings resolved yet",
    everyCaseLatestRun: "every case, latest run",
    noEvalRunYet: "no eval run yet",
    scanningInputsAndThe: "Scanning inputs/ and the wiki folders again.",
    testASkillBefore: "Test a skill before anyone relies on it.",
    mode: "Mode",
    mockNoModel: "Mock (no model)",
    replaySavedAnswers: "Replay saved answers",
    agent: "Agent",
    everyAgent: "Every agent",
    running: "Running…",
    newEvalRun: "New eval run",
    findingsKeptByPeople: "Findings kept by people",
    agentsPassing: "Agents passing",
    hiddenInstructionsHeld: "Hidden instructions held",
    qualitySignals: "Quality signals",
    met: "MET",
    notMet: "NOT MET",
    live: (min: string | number, runs: string | number, v: string | number) =>
      `LIVE ${min}/${runs} ${v}`,
    regressed: (v: string | number) => `${v} REGRESSED`,
    passRate: (agent: string | number) => `${agent} pass rate`,
    noEvalRunsYet: "No eval runs yet. Start one above (mock or replay).",
    passRateByAgent: "Pass rate by agent",
    ingestedContentIsData:
      "Ingested content is data, never instructions. A document with hidden or imperative text aimed at an AI reader is left out of every context pack until a person cleans the source. Facts verified from code are never overridden by a document.",
    quarantined: "QUARANTINED",
    marked: "MARKED",
    hidden: " · hidden",
    encoded: " · encoded",
    line: (
      line: string | number,
      rule: string | number,
      v: string | number,
      excerpt: string | number,
    ) => `line ${line} · ${rule}${v}: ${excerpt}`,
    flaggedTextOnLine: (line: string | number) => `Flagged text on line ${line}, shown inert`,
    quarantined2: (change: string | number) => `QUARANTINED · ${change}`,
    atticusNeverLetsA: (v: string | number) =>
      `Atticus never lets a quarantined source through on its own: clean or replace it, then scan again. Scanned ${v}.`,
    nothingRiskyInInputs: "Nothing risky in inputs/ or the wiki folders.",
    scanAgain: "Scan again",
    ingestedContentDefences: "Ingested-content defences",
    quarantined3: (v: string | number) => `${v} quarantined`,
    skipped: (skipped: string | number) => ` · ${skipped} skipped`,
    failed: (failed: string | number) => `${failed} FAILED`,
    allPassed: "ALL PASSED",
    noEvalRunsYet2: "No eval runs yet.",
    evalRuns: "Eval runs",
    approvedModelsLiveEvals: (v: string | number) =>
      `Approved models: ${v}. Live evals call a real model, so run them from a terminal: `,
    atticusEvalRunMode: "atticus eval run --mode live",
    locked: "LOCKED",
    availableOnceModelMode: (v: string | number) =>
      `Available once model mode is approved in runtime.yaml. It runs the same eval suite on each model and shows pass rate side by side. Not available in ${v} mode.`,
    compareModels: "Compare models",
  },
  governance: {
    allInTheExplorer: (total: string | number) => `All ${total} in the explorer`,
    governance: "Governance",
    theOrgPackConforms: "The org pack conforms.",
    someRulesNeedA: "Some rules need a decision.",
    fromTheFilesAnd: "From the files and the last scan",
    ofConformanceChecksPass: (pass: string | number, total: string | number) =>
      `${pass} of ${total} conformance checks pass`,
    ofChecksPass: (pass: string | number, total: string | number, v: string | number) =>
      `${pass} of ${total} checks pass${v}.`,
    conformance: "Conformance",
    orgPackChecks: "org pack checks",
    constitutionRules: "Constitution rules",
    locked: "LOCKED",
    orgPackRules: "Org-pack rules",
    teamRules: "Team rules",
    activeWaivers: "Active waivers",
    constitutionRulesCantBe: (inForce: string | number, waivable: string | number) =>
      `Constitution rules can't be waived or loosened. ${inForce} rules are in force; ${waivable} of them can be waived, each with a reason.`,
    refused: (file: string | number, v: string | number, reason: string | number) =>
      `Refused ${file}${v}: ${reason}`,
    rulesAndWaivers: "Rules and waivers",
    rule: "Rule",
    findings: "Findings",
    dismissed: "Dismissed",
    waived: "Waived",
    overridden: "Overridden",
    overridden2: (rule: string | number) => `${rule} overridden`,
    acrossARuleDismissed: (v: string | number) =>
      `Across ${v}. A rule dismissed again and again is a candidate for a checklist change, reviewed in a PR.`,
    noCriticFindingsYet: "No critic findings yet, so nothing to measure.",
    howOftenRulesAre: "How often rules are overridden",
    by: (by: string | number, v: string | number) => ` · by ${by} ${v}`,
    reason: (reason: string | number) => `Reason: ${reason}`,
    noActiveWaivers: "No active waivers.",
    waivers: "Waivers",
    sensitiveData: "Sensitive data",
    columnsTaggedWithA:
      "Columns tagged with a data classification, and so where tagged fields live.",
    noColumnsAreTagged:
      "No columns are tagged yet. Tag sensitive fields as curated decisions so their flows show here.",
    authenticationGaps: "Authentication gaps",
    callsWithNoOauth2: "Calls with no OAuth2, mTLS or API key declared in code or config.",
    everyCallDeclaresHow: "Every call declares how it authenticates.",
    timeoutsAndRetries: "Timeouts and retries",
    timeoutAndRetrySettings:
      "Timeout and retry settings, to compare a caller's patience with what it calls.",
    noTimeoutOrRetry: "No timeout or retry settings were found in code or config.",
    retiring: "Retiring",
    recordsPlannedForRetirement: "Records planned for retirement; check who still depends on them.",
    nothingIsPlannedFor: "Nothing is planned for retirement.",
    readOnlyBlastRadius:
      "Read-only blast radius from the catalog. Atticus never connects to live systems, consoles or monitoring. ",
    openTheImpactExplorer: "Open the impact explorer",
    incidentMode: "Incident mode",
  },
  learning: {
    lessonWord: "lesson",
    stepWord: "step",
    newChip: "NEW",
    doneChip: "DONE",
    notYet: (why: string, hint: string) => `Not yet: ${why}\nHint: ${hint}`,
    notYetNoHint: (why: string) => `Not yet: ${why}`,
    passed: (why: string) => `Passed: ${why}`,
    sandboxMade: (root: string) =>
      `Made a practice sandbox. Start the app there with: atticus ui --root ${root}`,
    inProgress: "IN PROGRESS",
    everyone: "Everyone",
    youHaveFinishedThis: "You have finished this lesson.",
    stepOf: (n: string | number, steps: string | number) => `Step ${n} of ${steps}`,
    tryInTheSandbox: "Try in the sandbox",
    copy: (c: string | number) => `Copy ${c}`,
    checkMyWork: "Check my work",
    hideTheHint: "Hide the hint",
    showAHint: "Show a hint",
    hint: (hint: string | number) => `Hint: ${hint}`,
    lessonsRunOnlyIn:
      "Lessons run only in a practice sandbox: a throwaway copy of the invented Forge estate. No network, no real systems, no real data. This metarepo isn't one, so lessons are read-only here.",
    aNewEmptyFolder: "A new, empty folder for the sandbox",
    homeYouAtticusSandbox: "a new empty folder, full path (or ~/atticus-sandbox)",
    makeASandbox: "Make a sandbox",
    learning: "Learning",
    practiceSandboxOfflineForge: "PRACTICE SANDBOX · OFFLINE FORGE",
    notASandbox: "NOT A SANDBOX",
    lessonsBuiltOnThe:
      "Lessons built on the Forge estate, with a sandbox to practise in. Nothing here touches a real system.",
    ofLessonsDone: (done: string | number, all: string | number) =>
      `${done} of ${all} lessons done`,
    ofDone: (done: string | number, v: string | number) => `${done} of ${v} done.`,
    progress: "Progress",
    lessonsDone: (role: string | number) => `${role} lessons done`,
    noLessonsAreInstalled: "No lessons are installed.",
    progressByKindOf: "Progress by kind of work",
    lessonsDone2: "lessons done",
    practiseInASandbox: "Practise in a sandbox",
    exercise: (title: string | number) => `Exercise · ${title}`,
    done: "done",
    writtenFor: "Written for",
    min: (role: string | number, minutes: string | number, v: string | number) =>
      `${role} · ${minutes} min · ${v}`,
    continue: "Continue",
    done2: "Done",
    start: "Start",
    lessonsRunInA: "Lessons run in a practice sandbox",
    noLessonsWrittenFor: "No lessons written for this kind of work.",
    lessonsAndExercisesUse:
      "Lessons and exercises use only the invented Forge ecosystem. A check passes from what the sandbox's files say, never from a model.",
    lessons: "Lessons",
  },
  release: {
    releasedChipWord: "RELEASED",
    openFindingsChip: (n: number) => `${n} OPEN`,
    clearChip: "CLEAR",
    mergedChip: "MERGED",
    laterChip: "LATER",
    openChip: "OPEN",
    blockersChip: (n: number) => `${n} BLOCKERS`,
    notFiledChip: (n: number) => `${n} NOT FILED`,
    filedChip: (n: number) => `${n} FILED`,
    fileWord: "file",
    bytes: (n: number) => `${n} B`,
    atGoNoGo: "AT GO / NO-GO",
    postReleaseReview: "POST-RELEASE REVIEW",
    noneNeeded: "NONE NEEDED",
    knowledgeGap: "a fact to ask for",
    approvedNotMerged: "APPROVED, NOT MERGED",
    notRaised: "NOT RAISED",
    goNoGoPr2: "Go / no-go PR opened. Reviewers decide on the Git host; merging it is the go.",
    /** Seventh UX walk: on a manual Git host, no PR is open until a person opens it. */
    goNoGoManual:
      "Go / no-go raised as a step for you: open its PR on the Git host from Home › Manual steps, then record its link. Merging it is the go.",
    waitsOnYouChip: "WAITS ON YOU",
    syncedWithTheGit: "Synced with the Git host.",
    archivedItsReposWere: "Archived. Its repos were rescanned.",
    changes: "Changes",
    noChangesInFlight: "No changes in flight.",
    next: "Next",
    type: (v: string | number) => `TYPE ${v}`,
    risk: (v: string | number) => `RISK ${v}`,
    requests: "Requests",
    snowMdListsNo: "snow.md lists no service-desk request.",
    ofFiled: (filed: string | number, total: string | number) => `${filed} of ${total} filed.`,
    findings: "Findings",
    blocking: (blocking: string | number, v: string | number) => `${blocking} blocking, ${v}.`,
    goNoGoPr: "Go / no-go PR",
    approvedBy: (v: string | number) => `; approved by ${v}`,
    mergingIsTheGo: (pr: string | number, v: string | number) => `Merging ${pr} is the go${v}.`,
    goNoGoIs: "Go / no-go is the release hand-off PR: merging it is the go.",
    archiveGate: "Archive gate",
    opensOnceReleasedMerged:
      "Opens once released, its release PRs merged and built, and its repos read again at the merged commit.",
    gatesToGoLive: "Gates to go-live",
    aPersonApprovesEvery:
      "A person approves every gate by merging its hand-off PR; the Git host decides who may approve, and the person who raised a PR can't be its only approver.",
    askForGoNo: "Ask for go / no-go",
    theChangeReachesGo: "The change reaches go / no-go after QA",
    syncAndMergeWhen: "Sync and merge when approved",
    readsThePrMerges:
      "Reads the PR; merges it as you once it is approved and the Git host's checks pass",
    archive: "Archive",
    archivesTheChangeAnd: "Archives the change and rescans its repos",
    /** ADR 0184: the release PRs, change/<id> into each code repo's default branch. */
    raiseReleasePrs: "Raise the release PRs",
    raisesReleasePrs:
      "Opens one PR per code repo from the change branch into its default branch, as you; a person merges each on the Git host",
    releasePrsRaised: "Release PRs raised. A person merges each on the Git host; Sync records it.",
    releasePrsNotYet: "The release PRs are raised once the build is done (in QA or at go / no-go).",
    releasePrs: "Release PRs",
    releasePrsIntro:
      "Each code repo's change branch, with the task PRs merged into it, goes into the repo's default branch by one PR. Atticus raises none while a task's branch has commits the change branch hasn't, and says which task. Go / no-go is decided over these; Atticus never pushes to the default branch, and a person merges each on the Git host.",
    noCodeRepos: "This change has no code repos (repos.yaml), so there is no release PR.",
    releasePrCol: { repo: "Repo", branch: "From", pr: "Release PR", build: "Checks" },
    releasePrsCaption: "Each code repo's release PR and its checks",
    notRaisedYet: "Not raised yet",
    prState: (n: number, state: string) => `#${n} ${state.toUpperCase()}`,
    /** Ninth UX walk: a manual Git host's release PR isn't open until a person opens it. */
    prToOpen: "Waits on you to open it, a step in",
    nothingStopsThisChange: "Nothing stops this change right now.",
    whatStopsIt: "What stops it",
    theChangeMayBe: "The change may be archived.",
    alsoTouchesAgreeAn: (v: string | number) => `Also touches ${v}. Agree an order before release.`,
    overlap: "OVERLAP",
    noOtherOpenChange: "No other open change touches the same things.",
    conflictsWithOtherChanges: "Conflicts with other changes",
    forTheApprovalBoard:
      "For the approval board or an audit: one Markdown document generated from the change folder (summary, every file with its sha-256, critic rounds and waivers, approvals, trace, requests and steps, drift and AI runs), each item with its source.",
    kb: (v: string | number) => `${v} KB`,
    evidenceFiles: "Evidence files",
    theChangeFolderIs: "The change folder is empty.",
    evidencePack: "Evidence pack",
    pickAChangeOn: "Pick a change on the left. Changes reach go / no-go after QA.",
    noChangeSelected: "No change selected",
  },
  releaseViews: {
    migrationChip: "MIGRATION",
    topicChip: "TOPIC",
    codeChip: "CODE",
    stepWord: "step",
    sensitiveSuffix: ", sensitive",
    interfaceWord: "interface",
    valueWord: "value",
    fileWord: "file",
    filedAs: (n: string | undefined) => `filed${n ? ` as ${n}` : ""}`,
    waitFor: (what: string, record: string | undefined) =>
      `${what}${record ? ` for ${record}` : ""}`,
    readyBy: (day: string, lead: string) => `, ready by ${day} (${lead})`,
    missing: (what: string) => `. Missing ${what}`,
    evidenceSaved: (file: string, files: string) =>
      `Saved ${file}: the summary, ${files} with their sha-256, rounds, waivers, approvals, trace, requests, drift and AI runs.`,
    gatewayRoute: "GATEWAY ROUTE",
    rollout: "Rollout",
    rollback2: "Rollback",
    readiness: "Readiness",
    verification: "Verification",
    hypercare: "Hypercare",
    onTrack: "ON TRACK",
    atRisk: "AT RISK",
    noTarget: "NO TARGET",
    releasedChip: "RELEASED",
    lateChip: "LATE",
    waitingForAPerson: "waiting for a person to file it",
    notFiled: "not filed",
    workingDay: "working day",
    noLeadTimeTo: ", no lead time to forecast",
    business: "Business",
    technical: "Technical",
    recorded: "Recorded.",
    workedOutFromInterfaces:
      "Worked out from interfaces.md, data.md, stories.md and the catalog: a route before its caller, a topic before its publisher, a migration before the code that reads it, a callee before its caller.",
    n0BeforeAnything: "0 · Before anything",
    from: (earliest: string | number) => ` · from ${earliest}`,
    waitsOn: (v: string | number) => `Waits on ${v}`,
    rollback: "Rollback",
    deployOrder: "Deploy order",
    beforeStep: (beforeStep: string | number) => `, before step ${beforeStep}`,
    notPlaced: "Not placed",
    criticReleaseLensStill: "Critic, release lens: still open",
    nothingToDeployYet:
      "Nothing to deploy yet: interfaces.md, data.md, tasks.md and stories.md name no repo.",
    deploymentPlan: "Deployment plan",
    computed: "computed",
    noDate: "No date",
    released: "Released.",
    readyToReleaseBy: (v: string | number) =>
      `Ready to release by this day at the earliest (${v} from today).`,
    target: (date: string | number, source: string | number) => `Target ${date} (${source}).`,
    noTargetDateThe: "No target date: the change isn't part of an initiative with one.",
    whatSetsTheDay: "What sets the day",
    waitOnAService: (v: string | number) => `; ${v} wait on a service request`,
    tasksOfDone: (done: string | number, total: string | number, v: string | number) =>
      `Tasks: ${done} of ${total} done${v}.`,
    forecast: "Forecast",
    fromDatesNoEstimates: "from dates, no estimates",
    rolloutReadinessAndHypercare: "Rollout, readiness and hypercare",
    fromDesignMd: "from design.md",
    signsOff: "Signs off",
    copyTheSecurityReview: "Copy the security review draft",
    interfacesMdListsNo: "interfaces.md lists no new or changed interfaces.",
    newOrChangedInterfaces: "New or changed interfaces and their auth",
    operation: "Operation",
    callerCallee: "Caller → callee",
    auth: "Auth",
    crosses: "Crosses",
    saidNowhere: "said nowhere",
    no: "no",
    dataFieldsTouched: "Data fields touched",
    dataMdAddsNo: "data.md adds no fields.",
    looksLikePersonalData: " (judged personal data)",
    dataCrossingABoundary: "Data crossing a boundary",
    noNewOrChanged: "No new or changed call crosses a system boundary.",
    mappingsMdDoesntSay: "mappings.md doesn't say which fields it sends.",
    vendorsSecretsAndFindings: "Vendors, secrets and findings",
    aNewVendor: "a new vendor",
    alreadyCalled: (v: string | number) => `already called (${v})`,
    noVendorSecretOr: "No vendor, secret or open security finding.",
    gapsForTheReviewer: "Gaps for the reviewer",
    securityReviewDraft: "Security review draft",
    fromTheCatalogAnd: "from the catalog and the change",
    audience: "Audience",
    copyTheReleaseNotes: "Copy the release notes",
    releaseNotes: "Release notes",
    generatedNoAi: "from the change folder; what breaks callers is judged",
    measuredByOn: (
      value: string | number,
      by: string | number,
      v: string | number,
      v2: string | number,
    ) => `${value}, measured by ${by} on ${v}${v2}`,
    notMeasuredYet: "Not measured yet.",
    measured: "MEASURED",
    open: "OPEN",
    recordedButBriefMd: (measure: string | number) =>
      `${measure}: recorded, but brief.md no longer has this measure.`,
    measure: "Measure",
    chooseAMeasure: "Choose a measure",
    whatYouMeasured: "What you measured",
    howOptional: "How (optional)",
    as: (user: string | number) => ` as ${user}`,
    record: (v: string | number) => `Record${v}`,
    recordAnOutcome: "Record an outcome",
    briefMdHasNo:
      'brief.md has no "Success measures" section, so there is nothing to measure after release.',
    outcomes: "Outcomes",
    theBriefsSuccessMeasures: "the brief's success measures",
    exportEvidencePack: "Export evidence pack",
    evidenceMd: (id: string | number) => `evidence-${id}.md`,
    copyEvidenceMd: (id: string | number) => `Copy evidence-${id}.md`,
  },
  serviceDesk: {
    requestWord: "request",
    exportWord: "export",
    filedChip: "FILED",
    ofChange: (c: string) => `Requests of ${c} only.`,
    showAll: "Show every change's",
    filters: {
      all: (n: number) => `All ${n}`,
      "to-file": (n: number) => `To file ${n}`,
      waiting: (n: number) => `Waiting ${n}`,
      filed: (n: number) => `Filed ${n}`,
    } as Record<string, (n: number) => string>,
    toFile2: "TO FILE",
    waitingForYou: "WAITING FOR YOU",
    drafted: "Drafted.",
    filedAsAStep: "Filed as a step.",
    toFile3: "To file",
    waitingForYou2: "Waiting for you",
    filed: "Filed",
    pastRequest: "past request",
    requestTemplate: "request template",
    draftTheRequestsA: "Draft the requests a change needs",
    replaceASnowMd: "Replace a snow.md a person edited",
    draftFromTheOrg: "Draft from the org pack's templates",
    noChangesToDraft: "No changes to draft requests for.",
    template: (template: string | number) => `TEMPLATE ${template}`,
    noTemplateMatches: "NO TEMPLATE MATCHES",
    leadTimeDays: (leadTimeDays: string | number) => `Lead time ${leadTimeDays} days. `,
    noneNamed: "none named",
    approversValuesComeFrom: (v: string | number, v2: string | number) =>
      `${v}Approvers: ${v2}. Values come from snow.md; fill a missing one below, or edit the file.`,
    fields: "Fields",
    copyAllFields: "Copy all fields",
    required: " · required",
    missingFillItIn: "Missing: fill it below",
    empty: "Empty",
    copy: (name: string | number) => `Copy ${name}`,
    atticusNeverCallsThe:
      "Atticus never calls the desk from here. Filing makes a step in To-do with every field ready to copy; you submit it in the desk and record the number.",
    fileSCompleteDrafts: (change: string | number) => `File ${change}'s complete drafts as steps`,
    fillFirst: (v: string | number) => `Fill ${v} first`,
    fillInSnowMd: (v: string | number) => `Fill ${v} above before filing.`,
    // Round 36 (UX review): fill the missing fields here, written into snow.md.
    fillTitle: "Fill the missing fields",
    fillHelp: (file: string) =>
      `Written into ${file}, as you would edit it: only these values change; its comments and other lines stay. If the file changed since this page read it, nothing is written.`,
    fillField: (name: string) => `${name} (required)`,
    fillSave: "Save to snow.md",
    fillSaving: "Saving…",
    fillDone: "Saved to snow.md.",
    fillSomething: "Type a value for at least one field first.",
    fillPropose:
      "snow.md changed in your copy of the metarepo. Propose it for review so the team sees the values; filing stays the File button's.",
    filedAsStep: "Filed as step ",
    submitItInThe: ". Submit it in the desk, then ",
    recordTheRequestNumber: "record the request number in To-do",
    filedAs: (number: string | number) => `Filed as ${number}`,
    open: "open",
    serviceDeskQueue: "Service desk queue",
    toFile: (v: string | number) => `${v} to file.`,
    nothingToFile: "Nothing to file.",
    show: "Show",
    draftsOnlyYouFile: "Drafts only: you file them. Next: the ",
    releasePlan: "release plan",
    requests: "Requests",
    noDraftsYet: "No drafts yet.",
    queue: "Queue",
    writesFromTheApp:
      "Writes from the app become steps you perform. Reads come from an export you load into inputs/.",
    from: (v: string | number, v2: string | number) => `${v} from ${v2}.`,
    noDeskExportLoaded: "No desk export loaded yet.",
    inTheOrgPack: (v: string | number, v2: string | number) => `${v} ${v2} in the org pack.`,
    serviceDeskAdapter: "Service desk adapter",
    approveEachWrite: (x: string | number) => `${x} · APPROVE EACH WRITE`,
    noneAllowedHere: "NONE ALLOWED HERE",
    calledThroughTheCommon: "Called through the common step spec from ",
    toDo: "To-do",
    noCredentialsPassTo: ". No credentials pass to the tool. ",
    executorsAllowList: "Executors allow-list",
    localAutomationTool: "Local automation tool",
    toFill: (v: string | number) => ` · ${v} to fill`,
    noneInThisView: "None in this view.",
    noServiceDeskDrafts: "No service-desk drafts. Draft them for a change below.",
    pickARequestOn: "Pick a request on the left.",
    noRequestSelected: "No request selected",
    draftRequests: "Draft requests",
  },
  /** ADR 0121: the AI tab, how AI runs here. */
  /** WP7.7: a system's page. */
  systems: {
    title: "Systems",
    pick: "Which system",
    empty: "No system in the catalog yet: read the repos first.",
    openPage: "Open its page",
    inFlight: "Changes in flight in its repos",
    noChanges: "No change in flight touches its repos.",
    questions: "Open questions about it",
    noQuestions: "No open question about it.",
    outside: "The systems outside the estate: vendors and other teams",
  },
  /** O4 (ADR 0149): one page per system outside the estate (a vendor, another team's). */
  // ADR 0164 (F7): the contract check on every link, estate-wide.
  mismatches: {
    title: "Mismatches",
    intro:
      "The payload on both sides of every link compared: each REST call, each hop through a gateway, each topic's publisher and listeners, and each call to an outside system, from the fields your assistant read and the specs on file. A difference that a mapping nobody traced touches is unconfirmed, never a mismatch. Read from the facts and the specs; nothing is written.",
    empty:
      "No link has a payload on both sides yet. Your assistant records what each call sends and each entry takes when it reads a repo (/atticus-map); atticus verify <repo> --write reads the repo's specs; atticus intake add takes a vendor's or another team's.",
    noneShown: "None of this kind: pick another in the list.",
    noneAtAll: "No difference on any link compared.",
    counts: (m: number, u: number, links: number, compared: number) =>
      `${m} mismatch${m === 1 ? "" : "es"}, ${u} unconfirmed; ${compared} of ${links} link${links === 1 ? "" : "s"} had a payload on both sides.`,
    unlinked: (n: number) =>
      `${n} call${n === 1 ? " joins" : "s join"} nothing yet, so ${n === 1 ? "its" : "their"} payload isn't checked: answer their questions on the Questions page, or re-read the repo (atticus map --all --stale).`,
    filter: "Show",
    filters: { all: "Everything", mismatch: "Mismatches", unconfirmed: "Unconfirmed" } as Record<
      string,
      string
    >,
    link: (from: string, what: string, to: string, through: string) =>
      `${from} ${what} → ${to}${through ? ` via ${through}` : ""}`,
    cols: { kind: "What", says: "Says", sender: "One side", receiver: "The other" },
    kinds: {
      "field-missing": "Read, never sent",
      "field-extra": "Sent, not taken",
      "field-not-sent": "Required, not sent",
      "field-required": "Required on one side only",
      "field-type": "Types differ",
      "field-number": "Field number reused",
      "error-unlisted": "Error not listed",
      "error-unanswered": "Error never answered",
    } as Record<string, string>,
    status: { mismatch: "Mismatch", unconfirmed: "Unconfirmed" } as Record<string, string>,
    via: (list: string) => `Through ${list}`,
    specs: (list: string) => `Specs read: ${list}`,
    notes: "Left out",
    command: "atticus join contracts",
    commandLabel: "Copy the command that prints this list",
  },
  outside: {
    noSuchSystem: (id: string) =>
      `No outside system of the profile is ${id}: pick one above, or add it in Map › Canvas (Add to the picture).`,
    title: "Outside systems",
    // ADR 0164: the calls to the system against its newest spec.
    contracts: "The calls against this spec",
    contractsIntro:
      "Each call to this system compared with the operation or message its newest spec publishes. Marked new: what this spec brings that the one it replaced didn't.",
    noContracts: "No call to it differs from its spec, or none says what it sends.",
    newWithSpec: "New with this spec",
    intro:
      "The systems no repo of the estate belongs to: vendors, and other teams' systems. For each, who calls it, the operations its spec publishes, the calls that match nothing in that spec, and the questions open about it. Read from the facts, the catalog and the specs in inputs/; nothing is written.",
    pick: "Which outside system",
    empty:
      "No outside system yet: the profiles name none that the estate's repos don't belong to. Add a vendor or another team's system to a profile's systems in the org pack.",
    boundary: {
      vendor: "A vendor",
      internal: "Another team's system",
      product: "A product no estate repo belongs to",
    } as Record<string, string>,
    owner: (owner: string) => `Owner: ${owner}`,
    aliases: (list: string) => `Also called ${list}`,
    callers: "Who calls it",
    noCallers:
      "No call in the estate's facts reaches it yet. A call reaches it when it names it, uses one of its hosts, or a person's answer says so.",
    callerCols: {
      from: "From",
      call: "Call",
      line: "Line",
      operation: "Operation",
      seen: "Seen in",
    },
    through: (repo: string, at: string) => `through ${repo} ${at}`,
    seen: {
      interface: "the catalog",
      join: "the estate join",
      spec: "its spec",
      shared: "their shared map",
    } as Record<string, string>,
    noOperation: "—",
    operations: "Its operations",
    specFrom: (path: string, title: string | undefined, version: string | undefined) =>
      `From ${path}${title ? `, ${title}` : ""}${version ? ` ${version}` : ""}`,
    opCols: { op: "Operation", line: "Spec line", calls: "Calls" },
    unmatched: "Calls that match nothing in its spec",
    noUnmatched: "Every call to it matches an operation its spec publishes.",
    ambiguous: "Calls two or more operations answer",
    ambiguousOf: (list: string) => `Could be ${list}`,
    noSpec: "No spec of it is in inputs/ yet, so its operations aren't known. Add one:",
    noSpecWhy:
      "Then intake links it to this system by name (atticus triage asks when it can't tell), and this page lists its operations and the calls that match none.",
    questions: "Open questions about it",
    noQuestions: "No open question about it.",
    answer: "Answer it",
    copy: (cmd: string) => `Copy: ${cmd}`,
    notes: "What the estate's facts left out",
    // ADR 0160 (O3): another team's map, read-only.
    shared: "Their shared map",
    sharedFrom: (name: string, commit: string, at: string) =>
      `${name}'s Atticus map, their commit ${commit.slice(0, 7)}, imported ${at.slice(0, 10)}. Their entries stay theirs: Atticus never verifies, corrects or reports on them; a wrong one is theirs to fix in their own map.`,
    sharedCols: { entry: "Their entry", repo: "Their repo", line: "Their line", calls: "Calls" },
    sharedUnmatched: "Calls their map has no entry for",
    noSharedUnmatched: "Every call to it is answered by an entry of their map.",
    noShared:
      "If the team that owns it runs Atticus, bring in their map, read-only, so calls to it join their entries:",
    sharedImport: (id: string) =>
      `atticus join shared import <their metarepo> --team <their team id> --system ${id} --name "<their team's name>"`,
  },
  /** WP7.1: the change cockpit, one change at a glance. */
  cockpit: {
    title: "This change at a glance",
    none: "No change yet: start one with atticus change new, and All changes lists it.",
    where: "Where it is",
    state: (state: string, risk: string) => `In ${state}, ${risk} risk.`,
    stages: { feature: "Placement", architecture: "Target flows", stories: "Stories" } as Record<
      string,
      string
    >,
    stageScreen: {
      feature: "feature-design",
      architecture: "architecture",
      stories: "stories",
    } as Record<string, string>,
    marks: { done: "done", current: "in progress", todo: "to come" } as Record<string, string>,
    stage: (name: string, mark: string) => `${name}: ${mark}`,
    progress: (drafts: number, rounds: number, open: number) =>
      [
        `${drafts} draft${drafts === 1 ? "" : "s"}`,
        `${rounds} critic round${rounds === 1 ? "" : "s"}`,
        ...(open ? [`${open} question${open === 1 ? "" : "s"} to answer`] : []),
      ].join(", "),
    next: "What's next",
    copySlash: "Copy the slash command",
    copyCommand: "Copy the command",
    // ADR 0191: the brief is a tab of the change now.
    writeBrief: "Write the brief on the Brief tab",
    openArchitecture: "Open the Architecture tab",
    blocks: "What blocks it",
    questions: (n: number) => `${n} question${n === 1 ? " waits" : "s wait"} for a person`,
    repos: "Repos and branches",
    noRepos: "No repo has a branch for this change yet.",
    /** Eighth UX walk: the change's branches are made here, on the person's click. */
    openWorkspace: (repos: number) =>
      `Make the change's branch in ${repos === 1 ? "its repo" : `its ${repos} repos`}`,
    workspaceOpened: "The change's branches are made in your clones.",
    // ADR 0191 (app-only audit): the brief has no repos; the architecture stage names them.
    noReposToOpen:
      "No repo is named for this change yet, so there is no branch to make. The architecture stage names the repos in its target flows:",
    /** Eighth UX walk: Raise hand-off held while the gate's status loads or something blocks it. */
    raiseHeld: (n: number) =>
      `${n} thing${n === 1 ? "" : "s"} block${n === 1 ? "s" : ""} the hand-off, so Raise hand-off waits:`,
    raiseChecking: "Checking what blocks the hand-off…",
    branchOn: (branch: string, base: string) => `${branch}, from ${base}`,
    pr: "the pull request",
    /** Sixth UX walk: a task drafted and waiting for its PR isn't the step to run again. */
    taskDrafted: (task: string) =>
      `Task ${task} is drafted: its PR is the step now. Raise it here or on the Task board.`,
    taskUnverified: (task: string) =>
      `Task ${task} is drafted but not built: its PR is the step now, and it waits on a build command (set it on Set up › Repos) or on you.`,
    taskPrRaised: (task: string) => `Task ${task}'s PR is raised; a person reviews and merges it.`,
    taskWaiting: (task: string) =>
      `Task ${task} is with your assistant: Done on its run checks it.`,
    thenTask: (task: string) => `Meanwhile, task ${task} is the first one not run yet:`,
    noOtherTask: "Every other task has run or is done.",
    openTaskBoard: "Open the Task board",
    raiseHere: "Raise it here: your click is your approval to open the hand-off PR.",
    watch: "Watch this change",
    unwatch: "Stop watching",
    watched: "You watch it: your digest says how it is doing.",
    unwatched: "You no longer watch it.",
    /** WP7.6: start from a similar change. */
    like: {
      title: "Earlier changes like this one",
      intro:
        "Archived changes whose brief is nearest this one's. One you pick is attached to this change as an example its steps read, as data.",
      byWords: (note: string) => `By shared words, since ${note}.`,
      none: "No archived change is near this one yet.",
      archived: (date: string) => `archived ${date}`,
      use: "Use as an example",
      used: "Attached to this change (Files attached): its steps read it as an example.",
    },
  },
  /** ADR 0123: Set up › Repos, each repo's branches. */
  repos: {
    yourAssistant: "Your assistant",
    title: "Repos and their branches",
    intro:
      "The catalog is read from each repo's default branch: that is the baseline, the one the hand-off PRs build on. Other branches people work on can be scanned beside it and compared with it, never merged into it.",
    empty:
      "No repo is listed yet. Add them above: paste their clone URLs, or discover a folder of clones.",
    typeOwner: (type: string, owner: string) => `${type} · ${owner}`,
    // ADR 0128: what a repo is, in a person's words.
    about: "What it is",
    noAbout: "Nothing says yet",
    aboutHint:
      "One line: what it is for, who uses it. It goes into every reading prompt, the questions a join asks and these views, so a repo whose id says nothing can still be read and placed. Up to 300 characters.",
    aboutWhy:
      "A person's note, not read from the code: where the two disagree, the facts read from the code are what counts.",
    aboutBy: (by: string) => `said by ${by}`,
    aboutDraft: "Unconfirmed draft",
    aboutDraftWhy: (by: string) =>
      `${by} drafted this from what it read. Until a person confirms it, it is marked unconfirmed everywhere it is used.`,
    aboutCites: "Read from",
    editAbout: "Say what it is",
    editAboutDraft: "Confirm, change or drop",
    acceptAbout: "Confirm it",
    rejectAbout: "Drop it",
    /** Ninth UX walk: each repo's buttons name the repo (their visible words first, WCAG 2.5.3). */
    editAboutFor: (repo: string) => `Say what it is: ${repo}`,
    editAboutDraftFor: (repo: string) => `Confirm, change or drop what ${repo} is`,
    acceptAboutFor: (repo: string) => `Confirm it: what ${repo} is`,
    rejectAboutFor: (repo: string) => `Drop it: what ${repo} is`,
    aboutSaved:
      "Saved to the manifest: commit it in a pull request. Every reading prompt, question and view now says what this repo is.",
    aboutDropped:
      "Dropped from the manifest: commit it in a pull request. Nothing says what this repo is now.",
    aboutTooLong: (max: number) => `One line, up to ${max} characters.`,
    aboutEmpty: "Say what it is, in one line, before saving.",
    url: "URL",
    defaultBranch: "Default branch",
    atCommit: (c: string) => `read at ${c}`,
    remoteSays: (b: string) => `The remote's default is ${b}`,
    branches: "Other branches",
    noBranches: "None listed",
    branchesHint:
      "One a line, for example develop or release/2026.11. Each can be scanned beside the baseline.",
    scanned: (b: string, date: string, c: string) => `${b} scanned on ${date}, at ${c}`,
    scan: (b: string) => `Scan ${b}`,
    scanStarted: (b: string) => `Scanning ${b} beside the baseline: follow it on Scans.`,
    compare: (b: string, def: string) => `Compare ${b} with ${def}`,
    comparedNow: "Compared.",
    compared: (b: string, added: number, removed: number, changed: number) =>
      `${b} against the baseline: ${added} added, ${removed} removed, ${changed} changed.`,
    edit: "Edit branches",
    editFor: (repo: string) => `Edit branches of ${repo}`,
    // Seventh UX walk: a repo's build command, set here instead of in repos.manifest.yaml.
    build: "Build command",
    noBuild:
      "None: a task drafted here isn't built or tested, so Atticus doesn't raise its PR. Set one here.",
    buildHint:
      "One line, run in the repo's folder, for example ./gradlew test or npm ci && npm test. A task's PR is raised only after it passes.",
    setBuild: "Set the build command",
    changeBuild: "Change the build command",
    /** Eighth UX walk: each repo's button names its repo (its visible words first, WCAG 2.5.3). */
    setBuildFor: (repo: string) => `Set the build command for ${repo}`,
    changeBuildFor: (repo: string) => `Change the build command for ${repo}`,
    buildOneLine: "One line: join the steps with &&.",
    buildSaved:
      "Saved to the manifest: propose it for review. Run the repo's drafted tasks again to build and test them.",
    buildCleared:
      "Cleared from the manifest: propose it for review. The repo's tasks aren't built or tested now.",
    save: "Save to the manifest",
    saved:
      "Saved to the manifest: commit it in a pull request. Run atticus workspace sync if the default branch changed.",
  },
  aiSettings: {
    changedOnDisk:
      "runtime.yaml changed on disk while this form was open (another window, or the command line). Your edits are kept here; Save writes them over what is there, or take the file's values.",
    takeDisk: "Take the file's values",
    title: "How AI runs here",
    intro:
      "Choose whether AI runs, which assistants your people use, and whether Atticus may call a model itself. Saving writes the org pack's runtime.yaml.",
    aiLabel: "AI here",
    ai: {
      on: "On: every AI step may run",
      "text-only": "Text only: no step is given a picture",
      off: "Off: no AI step runs; people write what agents would draft",
    } as Record<string, string>,
    assistantsLabel: "Assistants your people use",
    assistantsHint:
      "Atticus writes the slash commands, instructions and skills for each one ticked.",
    defaultAssistant: "Default assistant",
    modesLabel: "How a step runs",
    modes: {
      "hand-off": "Hand-off: the person's own assistant does the step",
      model: "Model: Atticus calls the provider below",
      "headless-claude-code": "Headless Claude Code: Claude Code runs the step on this machine",
      "copilot-acp":
        "Copilot, unattended: Atticus drives your own Copilot seat through its Agent Client Protocol (ADR 0171)",
    } as Record<string, string>,
    defaultMode: "Default",
    providerLabel: "Model provider",
    noProvider: "None: AI steps hand off to the person's assistant",
    providerHint:
      "Used when a step runs in model mode. A key never goes here: name the environment variable that holds it in keyEnv. For a provider Atticus has no built-in for, add a plugin: atticus plugin add vertex, or your own in org-pack/plugins/model-providers/.",
    pluginProvider: (id: string, pinned: boolean) =>
      pinned ? `${id} (plugin)` : `${id} (plugin, not pinned yet: atticus plugin pin ${id})`,
    keySet: (name: string) => `${name} is set on this machine.`,
    keyNotSet: (name: string) =>
      `${name} isn't set on this machine: set it to the key before testing.`,
    keyLabel: (name: string) => `The key for ${name}`,
    setKey: "Set the key on this machine",
    keyKept: (name: string) =>
      `Kept ${name} in this machine's credential store. It never goes in runtime.yaml.`,
    save: "Save",
    saved: (path: string) =>
      `Saved ${path}. Propose it for review: the org pack is reviewed like code.`,
    saveNote: (path: string) => `Saving writes ${path}; then propose it for review.`,
    test: "Test the provider",
    budgetsLabel: "Models and budgets",
    modelsLabel: "Models allowed",
    modelsHint: "One model id a line. Model mode refuses any other; empty allows any.",
    defaultTokensLabel: "Tokens for a step",
    perAgentLabel: "Tokens for an agent",
    perAgentHint: "One a line, for example architect: 300000. Others get the tokens for a step.",
    badDefaultTokens: "The tokens for a step must be a whole number above 0, such as 200000.",
    badBudgetLine: (line: string) =>
      `"${line}" doesn't read as an agent and its tokens: write it as architect: 300000.`,
    answered: (model: string, ms: number) => `${model} answered in ${ms} ms.`,
    notAnswered: (why: string) => `It didn't answer: ${why}`,
    /** Ninth UX walk (ADR 0181): whether the AI decides first, set here. */
    decideLabel: "AI decides first",
    decideHint:
      "Auto: after a Copilot session Atticus runs, or a hand-off to your assistant you mark done, Atticus applies each AI decision that passes the citation check and the bar, shown as Detected by AI and never as anyone's word; a person corrects what is wrong. Propose: the AI only proposes, and a person accepts each one. The safety rules are not affected.",
    decideLinks: "Pairings of calls to APIs",
    decideQuestions: "Answers to option questions",
    decideMode: { propose: "Propose for a person", auto: "Decide (auto)" } as Record<
      string,
      string
    >,
    minPrecisionLabel: "Pause below this audited precision (%)",
    minPrecisionHint:
      "When the sample audit puts the AI's decisions below it, deciding pauses back to propose and Home says why.",
    badMinPrecision: "The precision is a whole number of percent from 0 to 100, such as 95.",
  },
  /** Ninth UX walk: Home offers the upgrade the metarepo waits on, run here on the person's click. */
  upgrade: {
    title: "Upgrade this metarepo",
    intro: (n: number) =>
      `This metarepo waits on ${n} upgrade step${n === 1 ? "" : "s"} for this Atticus. Upgrading backs up every file it changes under .atticus/backups/, runs each step and stamps the metarepo; then propose the changes for review.`,
    newer: (stamp: string, mine: string) =>
      `A newer Atticus (${stamp}) upgraded this metarepo; this is ${mine}. Install ${stamp} or later before working in it.`,
    step: (summary: string, files: number) => `${summary} (${files} file${files === 1 ? "" : "s"})`,
    run: "Run the upgrade",
    running: "Upgrading…",
    done: "Upgraded. Propose the changed files for review.",
    failed: "The upgrade stopped.",
    terminal: "Or in a terminal:",
  },
  settings: {
    connectedChip: "CONNECTED",
    manualChip: "MANUAL",
    mockChip: "MOCK",
    onChip: "ON",
    offChip: "OFF",
    defaultOf: (v: string) => `(default ${v})`,
    autonomyLine: (dflt: string, rounds: number, capped: string | undefined) =>
      `${dflt} by default; at most ${rounds} build-fix rounds${capped ? `; capped: ${capped}` : ""}`,
    handOff: "Hand-off",
    yourOwnAssistantCopilot:
      "Your own assistant (Copilot or Claude Code) does the work. Atticus builds the context pack, watches the branch, then checks the result.",
    model: "Model",
    directModelAccessThrough:
      "Direct model access through an approved gateway. Unlocks draft-and-PR runs and model comparisons.",
    headlessClaudeCode: "Headless Claude Code",
    claudeCodeRunsA:
      "Claude Code runs a task on its own in the change's worktree; a person still approves every write.",
    workTracker: "Work tracker",
    serviceDesk: "Service desk",
    gitHost: "Git host",
    wiki: "Wiki",
    notifications: "Notifications",
    designTool: "Design tool",
    modelProvider: "Model provider",
    liveFallsBackTo: "live; falls back to steps for a person when it can't be reached",
    writesBecomeStepsIn: "writes become steps in To-do; reads come from exports",
    inMemoryForTests: "in-memory, for tests and demos",
    notSet: "NOT SET",
    notConfigured: "not configured",
    everyAiStepMay: "Every AI step may run, in the modes allowed below.",
    textOnly: "TEXT ONLY",
    noAiStepIs: "No AI step is given a picture; pictures go to a person in Intake.",
    noAiStepRuns:
      "No AI step runs. People write what agents would draft, the rule checks review it, and no gate waits for an AI lens.",
    saved: "Saved.",
    assistants: "Assistants",
    editors: "Editors",
    models: "Models",
    noneApproved: "none approved",
    autonomy: "Autonomy",
    contextBudget: "Context budget",
    runRecords: "Run records",
    buildEngine: "Build engine",
    telemetry: "Telemetry",
    platforms: "Platforms",
    checkAgain: "Check again",
    theSameChecksAs: "The same checks as ",
    atticusDoctor: "atticus doctor",
    nothingLeavesThisMachine: ". Nothing leaves this machine, and no secret is shown.",
    noChecksRan: "No checks ran.",
    thisMachine: "This machine",
    ready: "READY",
    needsFixing: "NEEDS FIXING",
    loading: "Loading",
    yourDigestListsThe:
      "Your digest lists the hand-offs waiting on your review and the blocking findings on changes you own. Atticus sends it only when you press Send it to me on Home, or when your own scheduled job runs ",
    atticusDigestAsSend: (user: string | number) => `atticus digest --as ${user} --send`,
    howOften: "How often",
    off: "Off",
    daily: "Daily",
    weekly: "Weekly",
    whereItGoes: "Where it goes",
    aDirectMessage: (user: string | number) => `@${user} (a direct message)`,
    save: "Save",
    yourNotifications: "Your notifications",
    atticusMeYaml: ".atticus/me.yaml",
    settings: "Settings",
    readOnlySetBy: "Read-only · set by the org pack, changed by PR",
    aiInThisOrganisation: "AI in this organisation",
    default: "DEFAULT",
    allowed: "ALLOWED",
    notApproved: "NOT APPROVED",
    safetyInEveryMode: "Safety, in every mode:",
    aPersonApprovesEvery:
      " a person approves every write, AI never pushes to protected branches or deploys, scans never call the network or a model, and ingested content is data, never instructions. These rules can't be configured.",
    runtimeModes: "Runtime modes",
    runtimeYaml: "runtime.yaml",
    everyOutsideSystemSits:
      "Every outside system sits behind an adapter. When one can't be reached, a manual adapter turns writes into steps a person does.",
    system: "System",
    adapter: "Adapter",
    testsAlwaysUseThe:
      "Tests always use the mock. Atticus never connects to live databases, consoles or monitoring.",
    adapters: "Adapters",
    builtInDefaultsFor: (v: string | number) => `Built-in defaults for: ${v}.`,
    openTheOrgPack: "Open the org pack",
    orgPack: "Org pack",
    theCriticRunsAt:
      "The critic runs at every gate; the org pack can add checks, never remove lenses. Constitution rules can't be waived. A gate is approved when its hand-off PR merges; your Git host decides who may approve.",
    gate: "Gate",
    phase: "Phase",
    checklists: "Checklists",
    checks: "Checks",
    authorRounds: "Author rounds",
    noLimit: "no limit",
    noGates: "No gates.",
    gates: "Gates",
    gatesYaml: "gates.yaml",
    proceduresCallLocalAutomation:
      "Procedures call local automation tools through one step spec. A tool the org pack doesn't allow doesn't run, and no credentials are passed to a tool. Tools are set up per machine in .atticus/executors.yaml.",
    noToolsAreSet: "No tools are set up on this machine.",
    executor: "Executor",
    kind: "Kind",
    allowedFor: "Allowed for",
    approval: "Approval",
    nothingOff: "NOTHING (OFF)",
    eachWrite: "each write",
    procedureAllowsWhichIsnt: (procedure: string | number, executor: string | number) =>
      `Procedure ${procedure} allows ${executor}, which isn't set up here.`,
    checkTheyAnswer: "Check they answer",
    addingAToolTo: "Adding a tool to the allow-list is an org-pack PR that its owners review.",
    executorsAllowList: "Executors allow-list",
    setUp: (v: string | number) => `${v} set up`,
  },
  runShared: {
    workTracker: "Work tracker",
    serviceDesk: "Service desk",
    gitHost: "Git host",
    wiki: "Wiki",
    notifications: "Notifications",
    designTool: "Design tool",
    copied: "Copied",
    selectAndCopy: "Select and copy",
    copy: "Copy",
    notSet: "NOT SET",
    manual: "MANUAL",
    mock: "MOCK",
    connected: (v: string | number) => `CONNECTED · ${v}`,
  },
  todo: {
    stepWord: "step",
    requestWord: "request",
    executorDid: (executor: string) => `${executor} did the step.`,
    recordedStep: (id: string) => `Recorded step ${id}.`,
    /** Seventh UX walk: a Git host step of a hand-off's PR syncs the change when it is done. */
    recordedAndSynced: (id: string, said: string) =>
      `Recorded step ${id}, and synced the change: ${said}`,
    skippedStep: (id: string) => `Skipped step ${id}.`,
    noClipboard: "This browser won't copy from here; use Copy all fields.",
    theseAreTheExact: "These are the exact inputs the tool gets. Approve them to run it.",
    copiedTheFieldsAs: "Copied the fields as CSV, ready to import.",
    allChanges: "All changes",
    noChange2: "No change",
    done2: "Done",
    open2: "Open",
    waitingOnOthers: "Waiting on others",
    workItem: "work item",
    choose: "Choose",
    patDana: "pat, dana",
    /**
     * Eighth UX walk: on a manual Git host anyone may type who approved; who recorded it is said
     * beside it, so an author recording someone else's approval shows.
     */
    approvalRecordedBy: (approvers: string, by: string) =>
      `Approved by ${approvers}, as recorded by ${by}. A manual Git host's approvals are what a person records here.`,
    localTool: "LOCAL TOOL",
    aToolOnThe:
      "A tool on the allow-list can do this step for you. You approve the exact inputs; it gets no credentials.",
    tool: "Tool",
    showTheInputs: "Show the inputs",
    inputsTheToolGets: "Inputs the tool gets",
    sha256: (v: string | number) => `sha-256 ${v}…`,
    runWithIApprove: (executor: string | number) => `Run with ${executor}, I approve these inputs`,
    manual: "MANUAL",
    procedure: (procedure: string | number) => `PROCEDURE ${procedure}`,
    whyThisIsManual: (reason: string | number) => `Why this is manual: ${reason}. `,
    whereEveryValueComes: (where: string | number, v: string | number) =>
      `Where: ${where}. ${v}Every value comes from the change files. Nothing is sent until you do it.`,
    it: "it",
    them: "them",
    doFirstThisStep: (v: string | number, v2: string | number) =>
      `Do ${v} first: this step depends on ${v2}.`,
    fieldsToCopy: "Fields to copy",
    copyAllFields: "Copy all fields",
    copyAsCsv: "Copy as CSV",
    empty: "Empty",
    copy: (name: string | number) => `Copy ${name}`,
    whenItsDoneRecord: "When it's done, record",
    optional: " (optional)",
    markDone: "Mark done",
    reasonToSkip: "Reason to skip",
    skipWithThisReason: "Skip with this reason",
    done: "Done",
    skipped: "Skipped",
    byALocalTool: " (by a local tool)",
    byOn: (
      v: string | number,
      by: string | number,
      v2: string | number,
      v3: string | number,
      v4: string | number,
      v5: string | number,
    ) => `${v} by ${by} on ${v2}${v3}.${v4}${v5}`,
    toDoAndManual: "To-do and manual steps",
    waitForAPerson: (v: string | number) => `${v} wait for a person.`,
    nothingToDoEvery: "Nothing to do: every manual step is done.",
    change: "Change",
    stepsAPersonDoes:
      "Steps a person does in the work tracker, service desk or Git host when Atticus can't reach them.",
    ofStepsDone: (closedLength: string | number, stepsLength: string | number) =>
      `${closedLength} of ${stepsLength} steps done`,
    steps: "Steps",
    noManualStepsYet: "No manual steps yet.",
    progress: "Progress",
    open: (open: string | number) => `${open} OPEN`,
    exportsInInputs: (v: string | number, v2: string | number) =>
      `Exports in inputs/: ${v}, ${v2}.`,
    noExportsInInputs:
      "No exports in inputs/ yet: drop a tracker or desk export there so Atticus can check results.",
    whereStepsComeFrom: "Where steps come from",
    allowListedToolsCan:
      "Allow-listed tools can do a step for you. A person approves each write and no credentials are passed. ",
    executorsAllowList: "Executors allow-list",
    noToolsSetUp: "No tools set up on this machine (.atticus/executors.yaml).",
    localAutomation: "Local automation",
    noChange: "no change",
    waits: "WAITS",
    toDo: "TO DO",
    openSteps: "Open steps",
    noOpenSteps: "No open steps.",
    pickAStepOn: "Pick a step on the left.",
    step: "Step",
    noStepSelected: "No step selected",
    procedure2: "Procedure",
    toolsAllowed: "Tools allowed",
    writes: "Writes",
    lastRun: "Last run",
    noneOff: "none (off)",
    notHere: " · not here",
    setUpHere: "Set up here",
    notSetUpOn: "Not set up on this machine",
    neverRun: "never run",
    theOrgPackHas: "The org pack has no procedures yet (process/procedures).",
    eachRunShowsThe:
      "Each run shows the exact inputs first, waits for your approval, and logs what happened. Protected branches and deploys are never touched.",
    proceduresALocalTool: "Procedures a local tool can run",
    nothingDoneYet: "Nothing done yet.",
    ownerNotKnown: "owner not known",
    copyQuestionText: "Copy question text",
    openChange: "Open change",
    eachQuestionIsAsked:
      "Each question is asked once and the answer is reused at every gate. Where notifications are set up, Send to the owner posts it; otherwise copy the text, ask the owner, then record what they said on the Questions page.",
    answerOnQuestions: "Record the answer",
    noOwnerQuestionsWaiting: "No owner questions waiting.",
    ownerQuestionsWaiting: "Owner questions waiting",
  },
  dashboardExtra: {
    of: (n: string | number, listed: string | number, label: string | number) =>
      `${n} of ${listed} ${label}`,
  },
  graph: {
    map: "Map",
  },
  /** The Architecture canvas (ADR 0081): what it is waiting for, said in words. */
  architecture: {
    readingEstate: "Reading the estate's catalog…",
    layingOutBoxes: (n: number) => `Laying out ${n} box${n === 1 ? "" : "es"}…`,
    joiningEstate:
      "Joining the estate to check each link's two sides… the marks of links whose sides disagree come next.",
    contractsFailed: (why: string) =>
      `Couldn't check the links' contracts, so no link is marked: ${why}`,
  },
  /** The diagram viewer every picture shares (F10): fit, zoom, search, focus and full screen. */
  viewer: {
    toolbar: "Picture controls",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    reset: "Actual size",
    fit: "Fit to screen",
    fitSelection: "Zoom to the picked box",
    focus: "Focus on the picked box",
    focusOff: "Show everything",
    fullScreen: "Full screen",
    leaveFullScreen: "Leave full screen",
    zoomLevel: (pct: number) => `Zoom ${pct}%`,
    search: "Find a box",
    searchPlaceholder: "Find a repo, system or topic",
    found: (label: string) => `${label}: centred and picked.`,
    notFound: (q: string) => `Nothing here is called ${q}.`,
    minimap: "Map of the whole picture",
    /** What each key does, said once beside the picture. */
    keys: "Keys: + and − zoom, 0 fits, 1 is actual size, arrows pan, S zooms to the picked box, M focuses on it, F is full screen, / finds a box, Esc leaves full screen.",
    region: (title: string) => `${title}: picture`,
    fullScreenOn: "Full screen: Tab stays inside the picture. Press Esc to leave.",
    focusOn: (label: string) =>
      `Focus on ${label} and what it links to; everything else is dimmed.`,
    details: "Details",
    hideDetails: "Hide details",
    showDetails: "Show details",
    /** Beta.26: the map's one bar of controls, and its legend folded over a corner. */
    mapControls: "Map controls",
    legend: "Legend",
  },
  /** Topics and queues on the picture (F10): who owns each, and what the estate lacks on it. */
  topics: {
    owner: (who: string) => `Owner: ${who}`,
    ownerOutside: (who: string) => `Owner: ${who} (outside the estate)`,
    ownerUnknown: "Owner not known",
    noListener: "No listener in the estate",
    noPublisher: "No publisher in the estate",
    noListenerFix:
      "Read the repo that listens on it, or, if a system outside the estate does, name that system so its listener is known.",
    noPublisherFix:
      "Read the repo that publishes to it, or, if a system outside the estate does, name that system so its publisher is known.",
    listens: "listens",
    // ADR 0162 §6 (F8): a topic or queue the profile names as an outside system's.
    declared: "Declared in the profile",
    declaredMark: "declared",
    declaredGap: "Only the profile says so: no repo of the estate shows the other side",
    declaredFix:
      "A person named it in the profile, so it rests on their word. If a repo of the estate serves the other side, read that repo: the code's link takes its place.",
  },
  me: {
    aiIsOffHere: "AI is off here, so write it yourself: the critic's rule checks still review it.",
  },
  flowsScreen: {
    thisFlow: "this flow",
  },
  flowsModel: {
    whoCallsThisEntry: "Who calls this entry point isn't known yet.",
    callerNotKnown: "Caller not known",
    /** The flows the join says call this one: the first's name, and how many more. */
    calledByFlows: (first: string, more: number) => (more ? `${first} and ${more} more` : first),
    start: "Start",
  },
  /** ADR 0106: what Atticus asked a model and what it answered, run by run. */
  /** ADR 0183: Apply and Propose for review, run from the app. */
  propose: {
    apply: (repo?: string) => (repo ? `Apply to ${repo}'s map` : "Apply"),
    applying: "Applying…",
    applied: (repo: string) => `Applied: ${repo}'s facts are checked again and in the catalog.`,
    applyFailed: "Verify found problems; they are listed above.",
    /** Round 41: the server refused to start it (another local step runs, say). */
    notStarted: (why: string) => `It didn't start: ${why}`,
    propose: "Propose for review",
    listed: "Here is what would be proposed.",
    title: "Propose for review",
    nothing: "Nothing has changed to propose.",
    willCommit: (branch: string, title: string) =>
      `These files go on branch ${branch} as "${title}", and a pull request is opened. Untick any you don't want in it.`,
    status: { "??": "new", M: "changed", A: "added", D: "removed", R: "renamed" } as Record<
      string,
      string
    >,
    yes: (n: number) => `Push ${n} file${n === 1 ? "" : "s"} and open the PR`,
    proposing: "Proposing…",
    proposed: "Proposed for review.",
    cancel: "Not now",
    appliedFlash: (repo: string) =>
      `Applied the correction to ${repo}'s map. It waits on Home to be proposed for review.`,
    toHome: "Propose it from Home",
    applyFirst:
      "Apply the answers and corrections first, so the map in the pull request matches them:",
    /** The map's bar: corrections drawn here, not yet applied (shown on the map itself). */
    onMap: (repos: string) =>
      `Your corrections aren't in the map yet: ${repos}. Apply them to check each against the code and draw the map again.`,
    /** Review of beta.24: put away what Apply to every repo's map said went wrong. */
    dismissErrors: "Dismiss these errors",
    onMapApplied: "Applied. The map is drawn again; propose it for review from Home.",
    pending: (n: number) =>
      `${n} file${n === 1 ? "" : "s"} you changed in the app ${n === 1 ? "isn't" : "aren't"} proposed for review yet.`,
    inReview: (where: string) => `already proposed (${where})`,
    bringIn: "Bring in what merged",
    bringingIn: "Bringing it in…",
    /** App-only audit: said at once, while the fetch runs. */
    bringingInSay: "Fetching what merged from the remote, then catching your copy up.",
    setUpstream: (upstream: string) => `Set the upstream to ${upstream}`,
    setUpstreamWhy:
      "A setting of your copy only: nothing is sent. Then Bring in what merged again.",
    bringInWhy:
      "When the PR has merged: your copy of the metarepo catches up, and your own edits stay.",
    whoMerges:
      "A person reviews and merges it on the Git host; Atticus never merges. Your click is your approval to push the branch.",
  },
  /**
   * ADR 0188: the app offers a button for every step in the daily path; the command it would
   * type is folded under "In a terminal".
   */
  appStep: {
    inTerminal: "In a terminal",
    applyAll: "Apply to every repo's map",
    applyingAll: "Applying…",
    appliedAll: "Applied: every repo's facts are checked again and the map is drawn again.",
    sync: "Sync the repos",
    syncing: "Syncing…",
    synced: "Synced the repos' clones.",
    // Review of beta.23 (ADR 0188): a step that needs a clone this machine doesn't have.
    syncFirstSay: (repos: string) =>
      `This machine has no clone of ${repos} yet. Sync it, then try the step again.`,
    syncFirstDone: (repos: string) => `Synced ${repos}: try the step again.`,
    sourcesSync: "Sync all wikis",
    sourcesSyncing: "Syncing the wikis…",
    sourcesSynced: "Synced every wiki into a dated snapshot.",
    join: "Join the estate's flows",
    joining: "Joining…",
    joined: "Joined: each flow's calls to other repos now reach their flows.",
    prune: "Clean up finished worktrees",
    pruning: "Cleaning up…",
    pruned: "Cleaned up. A worktree with uncommitted work is kept.",
    pruneSay:
      "Removes the worktrees of changes whose pull requests merged or closed. A worktree with uncommitted work is kept, as the command line keeps it.",
    taskContext: "Copy task context for my assistant",
    taskContextWorking: "Making the context…",
    taskContextCopied: "Copied. Paste it into your assistant in the task's repo.",
    taskContextFailed:
      "The browser didn't allow copying. Select the context below and copy it yourself.",
    taskContextSay: (repo: string) =>
      `For your assistant in ${repo}: the task, its stories, the design and the knowledge it needs.`,
    historyOn: "Turn recording on",
    historyOff: "Turn recording off",
    historyWorking: "Saving…",
    historyNowOn: "Recording is on on this machine.",
    historyNowOff: "Recording is off on this machine.",
    readRepoFirst: "Read a repo first",
    readRepoFirstSay:
      "Your assistant reads a repo's code and writes its facts; Atticus checks each against its line and draws the map.",
    openTrust: "Read a repo on Map › Trust",
    storiesAgain: "Draft the stories again",
    openArchitecture: "Prepare it on Architecture",
    findingAsk: "Ask its owner",
    findingFill: "Fill it in",
    openChangeFor: "Open it on the change's page",
    proposeSay: "Then propose it for review: a person approves the pull request.",
    openMap: "Open the map",
    readOnMap: (repo: string) => `${repo} is read and on the map.`,
    setupClones: "Sync the repos: it clones what's missing into the workspace.",
    setupMachine:
      "Open Settings › This machine: each check says how to fix it, and Check again reads them again.",
    openMachine: "Open Settings › This machine",
    ownInstall: "Your install",
    setupRead:
      "Read each repo with your assistant on Map › Trust; Done checks every fact against the line it cites and puts it on the map.",
    setupBaseline:
      "Walk the ecosystem map with the architect, then accept it with Accept the catalog below and propose it for review.",
  },
  /** UX review: starting a change in the app. */
  newChange: {
    start: "New change",
    title: "New change",
    titleLabel: "Title",
    titleHint: "Raise the daily transfer limit",
    idLabel: "Id (the folder and branch name)",
    typeLabel: "Type",
    noTypes: (why: string) => `The change types didn't load: ${why}`,
    create: "Start the change",
    starting: "Starting…",
    cancel: "Cancel",
    created: (id: string) => `Started ${id}. Its brief is next.`,
  },
  runs: {
    /** UX review: a run waiting on its hand-off answer is finished or cancelled here. */
    waitingSay:
      "This run waits for its answer. Paste the prompt into your assistant; when it has written the answer, Done checks it.",
    done: "Done: check the answer",
    failedSay:
      "The answer didn't pass its checks. Have your assistant fix what is listed, then Done checks it again:",
    /** Ninth UX walk: a failed hand-off says what to do once, not "waits for its answer". */
    failedAgainSay: "Fix the answer, then press Done again.",
    failedStill: "The answer still has the problems listed above.",
    copyPrompt: "Copy the prompt",
    nextPrompt: "Next: open the step's next prompt",
    doneOk: "Checked the answer.",
    cancel: "Cancel the run",
    cancelled: "Cancelled. The step can run again.",
    title: "Model runs",
    intro:
      "What Atticus asked a model and what came back, for every AI step, newest first. A prompt and an answer are shown as text, as they were written.",
    listTitle: "Runs",
    caption: "Model runs, newest first",
    cols: {
      step: "Step or change",
      agent: "Agent",
      model: "Model",
      round: "Round",
      state: "State",
      answered: "Answered",
      handedBack: "Handed back",
      when: "When",
    },
    /** ADR 0121 addendum: the kind of step picks the model; the model that ran it, when known. */
    classes: {
      read: "Read",
      draft: "Draft",
      critic: "Critic",
      knowledge: "Knowledge",
      quick: "Quick",
    } as Record<string, string>,
    modelCell: (stepClass: string | undefined, model: string | undefined) =>
      `${model ?? "Not recorded"}${stepClass ? ` · ${stepClass}` : ""}`,
    modelNotRecorded: "Not recorded",
    yes: "Yes",
    notYet: "Not yet",
    problems: (n: number) => (n === 0 ? "Nothing" : n === 1 ? "1 problem" : `${n} problems`),
    states: {
      prepared: "Prepared",
      waiting: "Waiting for its answer",
      produced: "Answered, not checked yet",
      validated: "Passed the checks",
      failed: "Failed",
      cancelled: "Cancelled",
    } as Record<string, string>,
    empty:
      "No model runs yet. A run is listed here once an AI step starts: run one from its page, or with its command or slash command.",
    emptyFor: (change: string) => `No model runs for ${change} yet.`,
    onlyFor: (change: string) => `Only the runs of ${change}.`,
    showAll: "Show every run",
    pick: "Open a run from the list to read what it was asked and what it answered.",
    back: "Back to every run",
    /** Eighth UX walk: a finished run with no next one goes back to its change, or its task. */
    toGlance: (change: string) => `Go on with ${change} on At a glance`,
    toTaskBoard: (task: string) => `Go on with task ${task} on the Task board`,
    toTaskBoardAny: "Go on with the tasks on the Task board",
    toNextRun: "Open the run that waits next",
    missing: (id: string) => `There is no run ${id}. It may have been removed from .runs/.`,
    runTitle: (change: string, round: number) => `${change}, round ${round}`,
    prompt: "Prompt",
    answer: "Answer",
    noAnswer: "No answer yet: the run is waiting for one.",
    handedBack: "Handed back",
    noneHandedBack: "Nothing was handed back: this is the step's first round.",
    roundProblems: (n: number) => `Round ${n}: the problems the checks found`,
    failedAnswer: (n: number) => `The answer round ${n} gave`,
    noFailedAnswer: "The answer that failed them isn't in the prompt.",
    /** ADR 0107 addendum: what the model looked at through its read-only tools. */
    tools: {
      title: "What the model looked up",
      offered: (names: string, n: number) =>
        `Read-only tools offered: ${names || "none"}. The model called them ${n === 1 ? "once" : `${n} times`}.`,
      stopped: (why: string) => `A cap stopped the tool calls (${why}).`,
      call: (round: number, name: string, tokens: number, refused: boolean) =>
        `Round ${round}: ${name}, ${tokens} tokens back${refused ? ", refused" : ""}`,
      returned: (name: string) => `What ${name} gave back`,
    },
    /** ADR 0116: how the run's context was retrieved, when a model helped. */
    retrieval: {
      title: "How the context was found",
      expansion: (run: string | undefined, cached: boolean) =>
        `The model read the input first${run ? ` (run ${run})` : ""}${cached ? ", an answer kept from before" : ""}.`,
      terms: (terms: string) => `Search terms: ${terms || "none"}.`,
      name: (name: string, id: string | undefined, isNew: boolean, quote: string) =>
        `${name}: ${id ? `the index's ${id}` : isNew ? "new in this change" : "nothing in the index"} ("${quote}")`,
      dropped: (name: string, why: string) => `Left out: ${name}, ${why}.`,
      rerank: (shown: number, kept: string, dropped: string) =>
        `The model ordered ${shown} candidates. Kept, in its order: ${kept || "none"}. Judged not needed: ${dropped || "none"}.`,
      rerankIgnored: (shown: number) =>
        `The model's order of ${shown} candidates named one it wasn't shown, so the engine's order stood.`,
      meaning: (note: string) => `Meaning: ${note}.`,
    },
    rounds: "Rounds of this step",
    round: (n: number) => `Round ${n}`,
    thisRound: "(this one)",
    /** ADR 0185: a stage's critic lenses asked in one prompt, each with its own run. */
    batch: {
      parts: "Lenses in this prompt",
      partsSay:
        "One prompt asks these lenses together; Done checks each lens's section on its own. A lens still out can be fixed here and Done pressed again, or answered alone from its own run.",
      lens: (name: string) => `The ${name} lens`,
      askedIn: "Asked in",
      askedInLink: "The prompt that asked the lenses together",
    },
    facts: {
      agent: "Agent",
      runtime: "Runs with",
      stepClass: "Kind of step",
      model: "Model",
      state: "State",
      started: "Started",
      finished: "Finished",
      size: "Prompt size",
      file: "Prompt file",
    },
    tokens: (n: number) => `${n} tokens`,
    textBox: (what: string) => `${what}, scrolls on its own`,
    forChange: (change: string) => `Model runs for ${change}`,
    knowledge: "Model runs of the knowledge steps",
    surveys: "Model runs of the surveys",
    all: "Every model run",
  },
  /** ADR 0110: what people asked their assistant in the metarepo, and what it answered. */
  history: {
    title: "Prompt history",
    intro:
      "What people asked their assistant in this metarepo and what it answered, by session, newest first. It is kept on this machine only, in .atticus/history/, and never committed. Each prompt and response is shown as text, as it was written.",
    what: "Recorded: prompts and replies in Claude Code with the Atticus plugin, and @atticus requests and replies in VS Code. Copilot's other chats can't be recorded: VS Code gives extensions no access to them, and Copilot in IntelliJ gives plugins no chat at all.",
    recordingOn: "Recording is on on this machine. Turn it off here, for this machine only.",
    offOrgPack:
      "Recording is off for everyone: the org pack's runtime.yaml says history: { record: false }. What was kept before is still here.",
    offLocal:
      "Recording is off on this machine. Turn it back on here; what was kept before is still here.",
    empty:
      "No prompts yet. With the Atticus plugin in Claude Code, or @atticus in VS Code, each prompt and reply in this metarepo is listed here.",
    change: "Change",
    everyChange: "Every change",
    session: (id: string) => `Session ${id}`,
    surfaces: {
      "claude-code": "Claude Code",
      vscode: "VS Code, @atticus",
      cli: "Command line",
    } as Record<string, string>,
    onlySession: (id: string) => `Only session ${id}.`,
    showAll: "Show every session",
    prompt: "Prompt",
    response: "Response",
    noResponse: "No response yet.",
    command: "Command",
    about: "About",
    box: (what: string, id: string) => `${what} ${id}, scrolls on its own`,
    truncated: (size: number) => `Cut at 64 KB: the text was ${size} bytes.`,
    masked: "Parts that looked like a secret were masked (***) before it was kept.",
    newest: (shown: number, total: number) =>
      `The newest ${shown} of ${total} turns. atticus history --limit n lists more.`,
    turns: (n: number) => (n === 1 ? "1 turn" : `${n} turns`),
  },
  /** ADR 0106: an AI step run from the app, with Copilot in a VS Code panel or the server's model. */
  /** ADR 0175 (G6): the canvas's tools. */
  /** ADR 0181 on the canvas: the Detected by AI layer, its legend, filter and a picked AI link. */
  canvasAi: {
    /** On a link's label: ◆ and the chip's words; how many of its calls when not all. */
    mark: (n: number, of: number) =>
      n >= of ? "◆ Detected by AI" : `◆ ${n} of ${of} calls detected by AI`,
    title: "Detected by AI",
    hint: "Links the AI paired as itself, from a run Atticus started, that no person has confirmed. Drawn dotted, with ◆ and the words. Pick one to see its run and correct it.",
    only: "Only links detected by AI",
    listed: (n: number) => `${n} link${n === 1 ? "" : "s"} on this picture detected by AI:`,
    pick: (from: string, to: string) => `Show the link ${from} → ${to}`,
    none: "No link on this picture was detected by AI.",
    noneOnly:
      "Only links detected by AI are shown, and this picture has none. Press the button again to show every link.",
    legend: "How links are drawn",
    legendCode: "Solid line: read from code",
    legendPerson: "Dashed line: a person's word (declared or paired)",
    legendAi: "Dotted line with ◆: detected by AI",
    // ADR 0192: a build dependency on a library of the estate's own, never a call.
    legendDependency: (n: number) =>
      `Dash-dot line, "depends on": a build dependency on a library of the estate's own, not a call (${n} on this picture)`,
    linkTitle: (from: string, to: string, type: string) => `${from} → ${to} (${type})`,
    link: "Link",
    close: "Close the link",
    gone: "This link isn't on the picture any more: a correction or a new read moved it.",
    corrected:
      "Correction saved as your word. The canvas was read again; the link moves once atticus verify --write has joined the caller's repo again.",
  },
  canvasTools: {
    types: "Types",
    typesHint:
      "The organisation's component types, as the boxes wear them. Click one to show only its components (the rest of your filter stays); again to show all.",
    title: "Layers, filters and tools",
    show: "Show the tools",
    hide: "Hide the tools",
    layers: "Layers",
    layer: {
      verified: "Read and cited",
      guessed: "Guesses and gaps",
      declared: "Declared (a person's word)",
      paired: "Paired by a person",
      // ADR 0181: the chip's words, so the layer and the chip are one thing.
      ai: "Detected by AI",
      outside: "Outside systems",
      topics: "Topics and queues",
    } as Record<string, string>,
    mismatches: "Only links whose two sides disagree",
    filter: "Filter",
    filterHint: "team:<id> system:<id> type:<repo or component type> path:/accounts/** or words",
    filtered: (n: number, all: number) => `${n} of ${all} boxes shown`,
    overlay: "Colour boxes by",
    questionsBadge: (n: number) => (n === 1 ? "open question" : "open questions"),
    overlayLoading: "Getting the open questions…",
    overlayFailed: (why: string) => `Couldn't get the open questions: ${why}`,
    viewsLoading: "Getting the kept views…",
    viewsFailed: (why: string) => `Couldn't get the kept views: ${why}`,
    saving: "Keeping it…",
    overlays: { none: "Nothing", gaps: "Gaps", questions: "Open questions" } as Record<
      string,
      string
    >,
    radius: "Blast radius of the selected box",
    radiusPick: "Select a box first.",
    radiusDir: { up: "What calls it", down: "What it calls", both: "Both" } as Record<
      string,
      string
    >,
    depth: (n: number) => `Depth ${n}`,
    radiusOn: "Show it",
    radiusOff: "Stop",
    radiusCount: (n: number) => `${n} boxes reached`,
    trace: "Trace from the selected box",
    traceNone: "Nothing goes out from it in this view.",
    hop: (d: number) => `Hop ${d}`,
    inbox: "Open on this picture",
    inboxNone: "Nothing open: no box or link here has a gap.",
    compare: "Compare",
    snapshot: "Keep a snapshot of the links now",
    snapshotAt: (at: string) => `Snapshot of ${at}`,
    compareOn: "Mark what changed since",
    added: (n: number) => `${n} links added (marked new)`,
    removed: (n: number) => `${n} links gone:`,
    noSnapshot: "No snapshot yet: keep one, change something, then compare.",
    views: "Saved views",
    viewName: "Name (lower case, e.g. ledger-calls)",
    save: "Keep this view",
    replace: (name: string) => `Replace ${name}`,
    saved: (rel: string) => `Kept in ${rel}: commit it to share it.`,
    open: "Open",
    noViews: "No view kept yet.",
    export: "Export the picture",
    exportEnd: {
      saved: "Saved.",
      cancelled: "Not saved: the Save dialog was closed.",
      failed: "Couldn't save the file here. Open the app in a browser to download it.",
    } as Record<"saved" | "cancelled" | "failed", string>,
    exports: {
      mermaid: "Mermaid",
      drawio: "draw.io",
      svg: "SVG",
      png: "PNG",
      pdf: "Print or PDF",
    } as Record<string, string>,
    openCode: "Open in your editor",
    openingCode: "Finding the file…",
    inVsCode: "VS Code",
    inIntellij: "IntelliJ",
    noCheckout: (why: string) => why,
  },
  /** ADR 0174 (G3): add a box, declare a link, and a box's corrections with Undo. */
  declare: {
    open: "Declare a link…",
    title: (system: string) => `Declare a link of ${system} the code can't show`,
    intro:
      "Your word, written to the profile with your name and the date for review: drawn dashed, never passed off as read from code. A declared topic is drawn where a repo of the estate publishes or listens on it with nobody on the other side.",
    kind: "What it does",
    kinds: {
      publishes: "Publishes to a topic or queue",
      listens: "Listens on a topic or queue",
      call: "Calls a gateway route",
    } as Record<string, string>,
    topic: "Topic or queue, as the code names it",
    route: "Route, as METHOD /path (or the handler proxy/flow)",
    preview: "Preview",
    previewing: "Working out the change…",
    confirm: "Write it",
    writing: "Writing…",
    written: "Written. Apply it to redraw the map, then propose it for review.",
    empty: "Say the topic or the route first.",
    close: "Close",
    copy: "Copy the command",
  },
  corrections: {
    title: "Corrections and declarations",
    show: "Show the corrections",
    loading: "Reading the corrections…",
    failed: (why: string) => `The corrections couldn't be read: ${why}`,
    none: "No corrections or declarations on this box.",
    by: (by: string, at: string) => `${by}, ${at.slice(0, 10)}`,
    kinds: {
      edit: "corrected",
      wrong: "marked wrong",
      link: "paired",
      topic: "declared topic",
      call: "declared call",
      unlink: "said it reaches none of these",
    } as Record<string, string>,
    undo: "Undo",
    undoing: "Undoing…",
    undone: "Undone. Apply it to redraw the map, then propose it for review.",
  },
  addBox: {
    open: "Add to the picture…",
    title: "Add to the picture",
    loading: "Reading the manifest and profiles…",
    failed: (why: string) => `What can be added couldn't be read: ${why}`,
    notRead: "Repos of the manifest not read yet: read one to draw it with its calls.",
    readCommand: (repo: string) => `atticus map --all --repos ${repo}`,
    allRead: "Every repo of the manifest is read.",
    newSystem: "A new vendor or another team's system",
    id: "Id (e.g. harbor-audit)",
    name: "Name",
    boundary: "It is",
    boundaries: { vendor: "a vendor", internal: "another team's system" } as Record<string, string>,
    owner: "Owner (for another team's)",
    noOwner: "None yet",
    preview: "Preview",
    confirm: "Add it",
    writing: "Adding…",
    previewing: "Working out the change…",
    written: "Added to the profile. Apply it to redraw the map, then propose it for review.",
    close: "Close",
    copy: "Copy the command",
  },
  /** ADR 0174 (G2): a repo's owner and system, set from its box. */
  owner: {
    open: "Owner and system…",
    title: (repo: string) => `Who owns ${repo}, and its system`,
    intro: (file: string) =>
      `Written to ${file} after your yes, the file's comments kept; the map shows it once you apply it.`,
    loading: "Reading the manifest…",
    failed: (why: string) => `The owner couldn't be read: ${why}`,
    owner: "Owner (a team)",
    system: "System",
    noSystem: "None",
    addTeam: "Add a team…",
    teamId: "New team's id (e.g. team-loyalty)",
    teamName: "New team's name",
    teamNote: "The team is added to roles.yaml for review, with nobody on it yet.",
    preview: "Preview",
    previewing: "Working out the change…",
    nothing: "That is what the manifest says already: nothing to change.",
    diffOf: (file: string) => `What changes in ${file}`,
    confirm: "Write it",
    writing: "Writing…",
    written: "Written. Apply it to redraw the map, then propose it for review.",
    close: "Close",
    copy: "Copy the command",
  },
  /** ADR 0174 (G1): connect two boxes call by call. */
  /** ADR 0178 part 2: Copilot proposes pairings; a person ticks them. */
  match: {
    intro:
      "Not enough from the paths? Copilot can read this repo's call sites (the constants and settings the paths are built from) and propose which API each call reaches, naming the lines. It writes nothing but its answer; every proposal you take is previewed and confirmed here like any pairing.",
    start: "Match with Copilot",
    again: "Match again",
    running: "Matching…",
    runningSay: (from: string, to: string) =>
      `Copilot is reading ${from}'s call sites against ${to}'s APIs. This takes a minute or two; the proposals appear here.`,
    readAnswer: "Read the answer",
    /** Ninth UX walk: reading the hand-off answer in is its run's Done. */
    readingAnswer: "Reading the answer in…",
    handoff: (brief: string) =>
      `The brief is written for your assistant (Copilot can't be started from here: runtime.yaml doesn't allow copilot-acp). In a new Copilot Chat (agent mode) or Claude Code session, say "read ${brief} and do what it says", then Read the answer. Atticus checks it; where runtime.yaml's decide.links is auto, it applies each pairing that passes the citation check and the bar as the AI's (Detected by AI), and the rest wait here for you.`,
    answerAt: (file: string) => `It writes its answer to ${file}.`,
    copy: "Copy",
    done: (p: number, n: number, r: number) =>
      `Copilot proposes ${p} pairing${p === 1 ? "" : "s"}${n ? `, says ${n} match${n === 1 ? "es" : ""} nothing here` : ""}${r ? `, and ${r} line${r === 1 ? "" : "s"} of its answer named a call or API that isn't one and ${r === 1 ? "was" : "were"} left out` : ""}. Nothing is written until you tick, preview and confirm.`,
    take: (n: number) => `Tick the ${n} proposed`,
    taken: "Ticked above",
    noneTitle: (n: number) => `${n} said to match nothing here`,
    rejectedTitle: (n: number) => `${n} left out`,
  },
  connect: {
    open: "Connect to…",
    title: (from: string) => `Connect ${from} to another box`,
    /** The two ends of the line, as a screen reader says them (the panel draws from → to). */
    ends: (from: string, to: string) => `From ${from} to ${to}`,
    dropNeedsRepo:
      "A line connects a repo's calls to another box: start or end it on a repo, a component in one, or a system that holds one repo. A system with several repos: open it (double-click) and draw from the repo. Two outside systems can't be connected here: declare the link on the system's box instead.",
    dropSameRepo:
      "Both ends are in the same repo, so there is nothing to connect: a repo's calls inside itself are read from its code.",
    intro:
      "Pair this repo's calls that join nothing with the other box's APIs. Each pair you confirm is one line in this repo's corrections, your word: the call's fact stays as read.",
    pickBox: "The other box",
    pickBoxNone: "Pick a repo or a system",
    loading: "Reading the calls and APIs…",
    failed: (why: string) => `The calls and APIs couldn't be read: ${why}`,
    /** Why the join left a call, in words (the join's reason codes). */
    leftWhy: {
      "no-host": "no host in its URL",
      "unresolved-placeholder": "its URL has a setting not resolved",
      "host-no-route": "its host serves no such route",
      "label-no-route": "no repo of that name serves it",
      "target-no-route": "its named target serves no such route",
      "generic-path": "its path is too generic to match",
      "answered-none": "answered as calling nothing here",
      "topic-unheard": "no one listens on its topic",
      "topic-unresolved": "its topic is a setting not resolved",
      "type-not-joined": "calls of this kind aren't joined",
    } as Record<string, string>,
    noCalls: (from: string) =>
      `${from} has no calls on record yet, so there is nothing to pair. Read its calls first:`,
    unverifiedCalls: (from: string) =>
      `${from}'s facts are read but not all verified, so the map leaves them out and there is nothing to pair yet. Verify them first:`,
    noApis: {
      "not-read": (name: string) => `${name} has no APIs on record yet. Read it first:`,
      unverified: (name: string) =>
        `${name}'s facts are read but not all verified, so its APIs aren't on the map yet. Verify them first:`,
      "no-spec": (name: string) => `${name} has no spec on file. Add its OpenAPI file:`,
    } as Record<string, (name: string) => string>,
    noLoose: "Every call of this repo joins something already: nothing loose to pair.",
    calls: "Calls that join nothing",
    caption: (from: string, to: string) => `${from}'s loose calls, each with an API of ${to}`,
    col: { pick: "Pair", call: "Call", line: "Line", status: "Now", api: "API" },
    pickApi: "Pick an API",
    likely: "Likely",
    allApis: "All APIs",
    findApi: "Find an API (type part of its path or name)",
    tickConfident: (n: number) => `Tick the ${n} confident`,
    tickSuggested: (n: number) => `Tick all ${n} suggested`,
    untickAll: "Untick all",
    tally: (confident: number, suggested: number, none: number) =>
      `${confident} confident, ${suggested} suggested, ${none} with no suggestion. A confident pair is the same path (or the same once a setting or a gateway's forwarding is read), well ahead of every other API.`,
    status: {
      asked: "asked",
      missed: "no route",
      left: "left",
      outside: "outside",
      unresolved: "not joined",
      paired: "paired by a person",
    } as Record<string, string>,
    why: {
      "same-path": "same path",
      prefix: "same but for a prefix",
      parameter: "same but for a parameter or setting",
      "names-alike": "names alike",
      setting: "the same path once its setting is filled in",
      "operation-words": "the operation's name says the same",
      "forwarded-path": "what the gateway's route forwards to",
    } as Record<string, string>,
    suggested: (why: string) => `Suggested: ${why}`,
    rule: (n: number) =>
      `All ${n} loose calls go there, and calls read later too: answer the open target question with /** (a rule)`,
    preview: "Preview",
    previewing: "Working out what changes…",
    confirm: (n: number, rule: boolean) =>
      n === 0 && rule
        ? "Answer for all its calls"
        : `${n === 1 ? "Write the pair" : `Write ${n} pairs`}${rule ? " and answer for all" : ""}`,
    writing: "Writing…",
    written: (n: number, file: string) =>
      n === 0 ? "No pair written." : `${n === 1 ? "One pair" : `${n} pairs`} written to ${file}.`,
    ruleWritten: (q: string) => `The open target question ${q} is answered with /**.`,
    undo: "Undo",
    undone: "Undone: the line is removed.",
    undoneRuleStays: (q: string, target: string) =>
      `Undone: the pair lines are removed. The rule's answer is not undone: the target question ${q} still sends this repo's loose calls, and calls read later, to ${target} (/**). To take it back, answer ${q} again on the Questions page.`,
    nothingPicked: "Pick at least one pair, or the rule for all.",
    pairedMark: "paired by a person",
    makeRule: "Make this a rule for every repo of this type?",
    makingRule: "Drafting the rule…",
    ruleMade: (file: string) =>
      `Drafted in ${file}, for review: a reader is given it once a person sets it active.`,
    close: "Close",
    copy: "Copy the command",
  },
  /** ADR 0173: an unattended Copilot run started from the app, and its Console. */
  /** ADR 0187: the Console: everything Atticus is doing or did lately, wherever it started. */
  activity: {
    title: "Console",
    open: "Open the Console",
    close: "Close the Console",
    list: "What ran",
    empty: "Nothing has run yet on this metarepo.",
    emptyHint:
      "Scans, syncs, Apply, AI steps, hand-offs and the commands you run in a terminal or an editor (atticus map, verify, scan, workspace sync…) show here while they run, with what they print.",
    loading: "Reading what ran…",
    failed: (why: string) => `Couldn't read what ran: ${why}`,
    retry: "Try again",
    runningCount: (n: number) => (n === 1 ? "1 running" : `${n} running`),
    kinds: {
      scan: "Scan",
      sync: "Sync",
      reconcile: "Reconcile",
      index: "Index",
      intake: "Intake",
      step: "AI step",
      local: "Local step",
      work: "Request",
      copilot: "Copilot run",
      command: "Command",
      handoff: "Hand-off",
    } as Record<string, string>,
    where: {
      app: "this app",
      terminal: "a terminal",
      vscode: "VS Code",
      intellij: "IntelliJ",
      copilot: "a Copilot session",
      assistant: "your assistant",
    } as Record<string, string>,
    states: {
      running: "running",
      waiting: "waiting for your assistant",
      done: "done",
      failed: "failed",
      cancelled: "cancelled",
      ended: "ended without saying",
    } as Record<string, string>,
    from: (where: string) => `from ${where}`,
    at: (time: string) => `at ${time}`,
    exitCode: (code: number) => `exit code ${code}`,
    stop: "Stop",
    stopping: "Stopping…",
    stopFailed: (why: string) => `Stop didn't go through: ${why}`,
    stopTerminal: "Stop it in its terminal (Ctrl+C).",
    endedWithoutSaying:
      "Its process is gone and it never said how it ended: the terminal was closed, or it crashed. Its lines up to then are below.",
    handoffWaits:
      "This waits for your assistant. The lines below say where the prompt is and how to finish it.",
    linesLoading: "Reading its lines…",
    linesFailed: "Couldn't read its lines. The Console tries again on its next look.",
    noLines: "Nothing printed yet.",
    follow: "Follow the end",
    search: "Search the log",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Couldn't copy here",
    noMatch: (q: string) => `No line has “${q}”.`,
    earlier: (n: number) => `${n.toLocaleString()} earlier lines not shown.`,
    loadEarlier: "Show earlier lines",
    dropped: (n: number) =>
      `${n.toLocaleString()} earlier ${n === 1 ? "line was" : "lines were"} dropped before these: the log keeps only its last lines.`,
    newLines: (n: number, title: string) =>
      n === 1 ? `1 new line in ${title}` : `${n} new lines in ${title}`,
    changed: (title: string, state: string) => `${title}: ${state}`,
    strip: {
      label: "Running now",
      running: (title: string) => `Running: ${title}`,
      step: (done: number, total: number) => `${done} of ${total}`,
      more: (n: number) => (n === 1 ? "and 1 more" : `and ${n} more`),
      show: "Show in the Console",
    },
  },
  /** The shell's bottom panel (beta.26): the Console, open questions, problems and runs. */
  bottomPanel: {
    label: "Panel",
    tabs: "Panel tabs",
    tab: {
      console: "Console",
      questions: "Questions",
      problems: "Problems",
      runs: "Runs",
    } as Record<"console" | "questions" | "problems" | "runs", string>,
    /** What a tab's count says to a screen reader. */
    count: (n: number) => (n === 1 ? "1 item" : `${n.toLocaleString()} items`),
    expand: "Show the panel",
    collapse: "Hide the panel",
    resize: "Resize the panel",
    resizeHint: "Drag, or use the up and down arrow keys, to change the panel's height.",
    running: (title: string, where: string) => `${title} · ${where}`,
    started: (title: string) => `Started: ${title}`,
    console: {
      noneSelected: "Pick a run in Runs to see its lines here.",
    },
    questions: {
      loading: "Reading the open questions…",
      failed: (why: string) => `Couldn't read the open questions: ${why}`,
      empty: "No question is open. Atticus asks here when it can't tell something from the code.",
      intro: (n: number) => (n === 1 ? "1 open question" : `${n.toLocaleString()} open questions`),
      openAll: "Open Questions",
      answer: "Answer",
      answerLabel: (q: string) => `Answer: ${q}`,
      more: (n: number) => `and ${n.toLocaleString()} more on the Questions page`,
    },
    problems: {
      loading: "Reading what needs attention…",
      findingsFailed: (why: string) => `Couldn't read the open findings: ${why}`,
      trustFailed: (why: string) => `Couldn't read the verifier's reports: ${why}`,
      empty:
        "Nothing needs attention: no run failed lately, no finding blocks a change and the verifier rejected no fact.",
      failedRuns: "Failed runs",
      blocking: "Blocking findings",
      rejected: "Facts the verifier rejected",
      failedRun: (state: string, where: string, time: string) => `${state} · ${where} · ${time}`,
      rejectedFacts: (repo: string, n: number) =>
        n === 1 ? `${repo}: 1 fact rejected` : `${repo}: ${n.toLocaleString()} facts rejected`,
      fixThenVerify: (command: string) => `Fix them, then run ${command}`,
      open: "Open",
      openLabel: (what: string) => `Open: ${what}`,
      openTrust: "Open Trust",
      show: "Show in the Console",
      showLabel: (title: string) => `Show ${title} in the Console`,
    },
    runs: {
      label: "Recent runs",
      hint: "Pick a run to see its lines in the Console.",
    },
    retry: "Try again",
  },
  copilotRuns: {
    start: {
      stale: "Read the stale repos with Copilot",
      gaps: "Fill the gaps with Copilot",
      all: "Read the repos not read yet with Copilot",
      repos: (repo: string) => `Read ${repo} with Copilot`,
      again: (repo: string) => `Read ${repo} again with Copilot`,
    },
    hint: "Copilot reads unattended, one new session per part, and Atticus verifies each part. You see each step in the Console.",
    confirm: {
      title: "Start a Copilot run?",
      what: {
        stale: "Re-read every repo whose clone moved past its facts.",
        gaps: "A second pass on the gaps of every read repo: calls with no target, entries no flow follows.",
        all: "Read every repo of the manifest not read yet.",
        repos: (repos: string, force: boolean) =>
          `${force ? "Read again, whole: " : "Read: "}${repos}.`,
        staleRepos: (repos: string) =>
          `Re-read those of ${repos} whose clone moved past its facts.`,
        gapsRepos: (repos: string) => `A second pass on the gaps of ${repos}.`,
      },
      model: (model?: string) =>
        model ? `Model: ${model} (runtime.yaml's copilotAcp).` : "Model: Copilot's default.",
      may: "Each session may only read the code, write facts and run atticus verify. It can't answer, accept, audit or mark anything done as you, and it never pushes, deploys or writes anywhere else.",
      long: "A large repo takes several sessions. Stop at any time: the next run carries on from there.",
      yes: "Start the run",
      no: "Not now",
    },
    notAllowed: "Copilot can't be started from here",
    starting: "Starting…",
    failedToStart: (why: string) => `The run didn't start: ${why}`,
    strip: {
      running: "Copilot is reading",
      planning: "Planning the run…",
      repo: (n: number, total: number, repo: string) => `Repo ${n} of ${total}: ${repo}`,
      session: (title: string) => `Session: ${title}`,
      totals: (kept: number, rejected: number, tokens: number) =>
        `${kept} facts kept, ${rejected} rejected${tokens ? `, ${tokens.toLocaleString()} tokens` : ""}`,
      done: "The Copilot run finished.",
      stopped: "The Copilot run stopped. The next run carries on from there.",
      failed: (why: string) => `The Copilot run stopped: ${why}`,
      stop: "Stop",
      stopping: "Stopping…",
      stopFailed: (why: string) => `Stop didn't go through: ${why}`,
      showConsole: "Show the Console",
      dismiss: "Dismiss",
    },
    console: {
      title: "Console",
      open: "Open the Console",
      close: "Close the Console",
      tabs: "Console tabs",
      follow: "Follow the end",
      search: "Search the log",
      copy: "Copy",
      copied: "Copied",
      empty:
        "No Copilot run yet. Start one from Map › Trust: read the stale repos, fill the gaps, or read one repo.",
      noLines: "Nothing printed yet.",
      noMatch: (q: string) => `No line has “${q}”.`,
      earlier: (n: number) => `${n.toLocaleString()} earlier lines not shown.`,
      loadEarlier: "Show earlier lines",
      notKept: (n: number) =>
        `${n.toLocaleString()} earlier lines are no longer kept (the app keeps a tab's last 5,000).`,
      runTab: "Run",
      copyFailed: "Couldn't copy here",
      states: { running: "running", ended: "ended", failed: "failed" } as Record<string, string>,
    },
  },
  bridge: {
    noAnswer: "No answer from VS Code",
    stepSilent:
      "No word from VS Code about this step for an hour: given up here. Its run, if any, is in Runs.",
    noAnswerTo: (path: string, s: number) =>
      `No answer to ${path} in ${s} s. Close the Atticus panel and open it again.`,
  },
  runStep: {
    /** UX review: in a browser with no model, the step is prepared for the person's assistant. */
    handoffPrepare: "Prepare it for your assistant",
    /** ADR 0188: the read of a repo, prepared for the person's assistant. */
    handoffRead: "Read with my assistant",
    handoffReadHint:
      "Atticus writes the prompt for your assistant (Copilot, Claude Code) to read the repo's code into facts; Done checks each fact against its line and puts the kept ones on the map.",
    handoffWorking: "Preparing…",
    handoffHint:
      "Atticus writes the prompt; paste it into your assistant (Copilot, Claude Code), then Done checks the answer.",
    handoffReady: "Prepared.",
    handoffStill: "A run of this step still waits for its answer.",
    handoffOpen: "Open the prompt and Done",
    handoffOpenWaiting: "Open the run that waits",
    withCopilot: "Run with Copilot",
    withModel: (model: string) => `Run with ${model}`,
    running: "Running…",
    busy: "The step is running. The button comes back when it ends.",
    hintCopilot: "Copilot runs it in VS Code, with your consent, and the checks read its answer.",
    hintModel: (model: string) =>
      `The server runs it with ${model}, as runtime.yaml sets, and the checks read its answer.`,
    started: (model: string) => `Started on the server with ${model}.`,
    progress: "Progress",
    output: "What the step printed",
    ends: {
      done: "Done: the step finished.",
      handoff: "Handed off: the prompt waits for its answer.",
      question: "It asked a question: answer it in Waiting on you, then run the step again.",
      stopped: "It stopped: its checks found problems. Read the run to see them.",
      failed: "It failed.",
      cancelled: "Cancelled.",
      "too-long": "It stopped: the prompt was too long for the model.",
      "no-consent": "It didn't run: Copilot wasn't allowed to use the model.",
      "no-model": "It didn't run: no Copilot model is available.",
      "model-error": "It stopped: the model answered with an error.",
      "too-many-rounds": "It stopped: the checks still found problems after the last round.",
    } as Record<string, string>,
    /** The extension refused the step, or couldn't start it: its first line says why. */
    refused: (why: string) => `It didn't run: ${why}`,
    ended: (state: string) => `It ended: ${state}.`,
    openRun: "Read the run in Model runs",
    openRuns: "Open Model runs",
    cancel: "Cancel",
    cancelling: "Stopping…",
    cancelHint: "Stops the model call; nothing from this run is kept.",
    cantStart: (why: string) => `Couldn't start it: ${why}`,
  },
  nextStep: {
    releasePlan: "Release plan",
  },
  /** ADR 0124 addendum D-app, F3: the Map with its evidence, and correcting a fact in place. */
  evidence: {
    cite: (at: string) => `Where this was found: ${at}`,
    citeOf: (at: string, repo: string) => `Where this was found: ${repo}, ${at}`,
    loading: "Reading the facts for this line…",
    quote: "The line, as the reader quoted it",
    noQuote: "No quote was kept for this line.",
    facts: (n: number) => `${n} fact${n === 1 ? "" : "s"} on this line`,
    by: {
      assistant: "read by the assistant",
      reader: "read by a built-in reader",
      person: "a person's fact",
    } as Record<string, string>,
    verified: {
      line: "checked on its line by atticus verify",
      sample: "checked by a sample session",
      person: "confirmed by a person",
      none: "not checked yet: run atticus verify",
    } as Record<string, string>,
    gaps: {
      unverified: "No fact verified from code cites this",
      question: "A question is open on this",
      corrected: "A person corrected this; atticus verify applies it",
    } as Record<string, string>,
    short: {
      unverified: "unproven",
      question: "question open",
      corrected: "corrected",
    } as Record<string, string>,
    noFacts: (repo: string) =>
      `${repo} has no facts yet: what is drawn from it comes from the built-in readers, not from a read the verifier checked.`,
    openQuestion: "Answer it",
    correct: "Correct this",
    correctFact: (label: string) => `Correct the fact ${label}`,
    close: "Close",
    correctTitle: (label: string) => `Correct ${label}`,
    correctIntro:
      "Say the fact is wrong, or put the claim right. Atticus writes your correction to the repo's corrections file; atticus verify applies it every time it runs, so the next read keeps it. A corrected claim is still checked on its line: the code must say it.",
    wrong: "It is wrong",
    edit: "Put the claim right",
    reason: "Why (required to mark it wrong)",
    reasonOptional: "Why (optional)",
    line: "Line it is on",
    save: "Save the correction",
    saving: "Writing the correction…",
    needReason: "Say why the fact is wrong first.",
    nothingChanged: "Change a field or the line first.",
    saved: (file: string) => `Written to ${file}.`,
    correction: (action: string, by: string, pairedWith?: string) =>
      action === "wrong"
        ? `Marked wrong by ${by}`
        : action === "link"
          ? `Paired with ${pairedWith ?? "another system"} by ${by}`
          : `Corrected by ${by}`,
    links: "Links",
    noLinks: "No link starts or ends here in this view.",
    linkOf: (from: string, to: string, type: string) => `${from} ${type} ${to}`,
  },
  /**
   * C4 (ADR 0149): after any correction the app writes, the commands to run (the app runs none)
   * and what the next verify --write will change, worked out without writing.
   */
  correctionNext: {
    title: "What happens next",
    onlyWrote: (file: string) =>
      `The app wrote only ${file}. Apply uses it; then Propose for review, here or later from Home (what you haven't proposed waits there). A person reviews the pull request.`,
    fileDiff: (file: string) => `The change to ${file}, as written`,
    stepsTitle: "Or on the command line, in order",
    step: {
      verify: "Apply it: verify checks the facts again and writes the catalog",
      branch: "Make a branch for the change",
      add: "Add the exact files the write changes",
      commit: "Commit them",
      push: "Push the branch",
      pr: "Open a pull request",
    } as Record<string, string>,
    prByHand: (branch: string) =>
      `Open a pull request from ${branch} on your Git host. Set adapters.gitHost in org-pack/runtime.yaml and Atticus gives its command here.`,
    copy: (what: string) => `Copy: ${what}`,
    previewTitle: "What atticus verify --write will change",
    previewIntro:
      "Worked out here by the same checks the command runs, without writing anything. It compares with the catalog on disk, so it also shows anything else waiting to be written.",
    loading: "Working out what the write will change…",
    failed: (why: string) => `Couldn't work out what the write will change: ${why}`,
    unavailable: {
      "no-checkout":
        "There is no checkout of the repo here, so what the write changes can't be worked out. Clone it (atticus workspace sync); the commands still apply.",
      "unreadable-facts":
        "The repo's facts file doesn't read as facts, so the write would change nothing yet. Have your assistant read the repo again.",
    } as Record<string, string>,
    blocked: (n: number) =>
      `The write puts nothing in the catalog: ${n} fact${n === 1 ? " is" : "s are"} rejected. Fix ${n === 1 ? "it" : "them"} first (Map › Trust lists ${n === 1 ? "it" : "them"}).`,
    headMoved: (head: string, commit: string) =>
      `The checkout is at ${head.slice(0, 7)}, past the facts' commit ${commit.slice(0, 7)}: verify reads the changed files' facts again, which this preview doesn't.`,
    facts: "Facts",
    dropped: "Left out",
    droppedWhy: {
      wrong: "marked wrong by a person",
      rejected: "rejected by the verifier",
    } as Record<string, string>,
    edited: "Edited",
    field: (name: string, was: string | undefined, now: string | undefined) =>
      `${name}: ${was ?? "(none)"} → ${now ?? "(none)"}`,
    noFactChange: "No fact changes.",
    kept: (n: number) => `${n} fact${n === 1 ? "" : "s"} kept.`,
    links: "Links",
    moved: (what: string, was: string, now: string) => `${what}: moves from ${was} to ${now}`,
    added: (what: string) => `${what}: added`,
    removed: (what: string) => `${what}: removed`,
    changed: (what: string, was: string, now: string) => `${what}: ${was} → ${now}`,
    unmade: (what: string) =>
      `${what}: this repo no longer makes it (the record stays, held by the other side, until that repo is written again)`,
    linkWhat: (from: string, to: string, method: string | undefined, path: string) =>
      `${from} → ${to} ${method ? `${method} ` : ""}${path}`,
    noLinkChange: "No link changes.",
    catalog: (added: number, changed: number, removed: number, evidence: number) =>
      `Catalog records: ${added} added, ${changed} changed, ${removed} removed, ${evidence} with only their evidence changed.`,
    stale: (ids: string) =>
      `Corrections on file that meet no fact in this read (kept, applied when it is read again): ${ids}.`,
  },
  /** ADR 0135, C1 and C2: why a link is there, and saying it is wrong. */
  why: {
    // ADR 0164: the contract check's findings on a call of the link.
    contracts: "Contract",
    contractsOf: (m: number, u: number) =>
      `${m} mismatch${m === 1 ? "" : "es"}${u ? `, ${u} unconfirmed` : ""} between what each side sends and takes`,
    contractsAll: "All mismatches",
    open: "Why is this linked?",
    openOf: (link: string) => `Why is ${link} linked?`,
    intro:
      "Each call on this link, how Atticus joined it to what it calls, and the line it cites at each end. A verified call is read from code at both ends and named by someone; an inferred one is a guess.",
    call: (from: string, to: string, what: string) => `${from} → ${to}${what ? `: ${what}` : ""}`,
    // The arrow's panel: how many calls under its name, and each call's Copy.
    count: (n: number) => `${n} call${n === 1 ? "" : "s"}`,
    copyOf: (what: string) => `Copy ${what}`,
    how: {
      person:
        "A person paired this call with this entry on the canvas (Connect to…): their word, written as a link in the caller's corrections, the call's own fact left as read.",
      answer: "A person answered which repo or system it calls.",
      named: "The call names the component it goes to.",
      repo: "The call names the repo it goes to.",
      host: "The call's host is one the manifest lists for that repo.",
      "base-path":
        "The gateway forwards the call with no host (a proxy chained to another), and its whole path starts with this proxy's base path: this is the one route under it with its method and path.",
      declared: "A person declared who calls this gateway route.",
      topic: "It publishes a topic the other side listens to.",
      path: "Nobody named where it goes: it is the only entry in the estate that serves its path, so this is a guess.",
      label:
        "Its host names no repo; the host's first part happens to be a component's name, so this is a guess.",
      "platform-setting":
        "Its host comes from a platform-wide setting nobody set for this service, so this is a guess.",
      "folder-name":
        "Its host comes from a setting that is this service's only because its file sits in a folder named like it, so this is a guess.",
      conflict:
        "Its host or base path is one a deploy file gives and the manifest disagrees with (an open conflict on Map › Trust), so this is a guess.",
      "service-name":
        "Its host is a Kubernetes Service's short name, which reaches that Service only from its own namespace, and no deploy file says this service runs there, so this is a guess.",
      shared:
        "It calls another team's system, and the map that team shares has the entry that answers it.",
      ai: "The AI paired this call with the entry, as itself, from a run Atticus started. No person has confirmed it; correct it if it is wrong.",
      // ADR 0192: a build dependency on a library of the estate's own.
      coordinates:
        "Its build file declares a dependency on the coordinates the other repo's build publishes: a library of the estate's own, both lines checked. It is a build dependency, not a call.",
      unknown:
        "The catalog doesn't say how this was joined: it was written before Atticus kept that, or by a built-in reader. Run atticus verify on the caller's repo with --write to record it.",
    } as Record<string, string>,
    // Beta.25 review: an inferred join's own words where they differ from a verified one's.
    howGuessed: {
      "base-path":
        "Joined by the proxy's BasePath; the caller's host is unknown. Its whole path starts with this gateway proxy's base path, and this is the one route under it with its method and path, but nothing says the call goes to this gateway, so this is a guess.",
    } as Record<string, string>,
    gateway: "It goes through a gateway on the way.",
    // ADR 0162 §6 (F8): a topic or queue a person named as an outside system's in the profile.
    declared: "Declared in the profile",
    declaredTopic:
      "Declared in the profile: a person named this topic or queue as that system's, and no repo of the estate serves the other side. It rests on their word, not on code at both ends.",
    declaredIn: "In the profile",
    // ADR 0160 (O3): the answering side is another team's map.
    sharedMap: (team: string, commit: string | undefined) =>
      `Joined to ${team}'s map${commit ? ` (their commit ${commit.slice(0, 7)})` : ""}.`,
    sharedTheirs: (team: string) =>
      `What answers it is ${team}'s, read from the map they share: Atticus never verifies or corrects it. If their entry is wrong, tell ${team}; correct this call only if it goes somewhere else.`,
    verified: "✓ Verified",
    inferred: "△ Inferred",
    caller: "The call",
    callee: "What answers it",
    hops: "Through the gateway",
    other: "Lines cited",
    noLine: "No line cited at this end.",
    more: (n: number) =>
      `${n} more call${n === 1 ? "" : "s"} on this link. Open either end to see its calls one by one, or list the Interface records with atticus query "kind:interface".`,
    none: "This link isn't a call, so there is no join to explain: its lines are listed under it.",
    // Beta.24 review: on a verified link, the guesses its other merged calls rest on (beta.25:
    // and the pairings, a person's or the AI's word, which never verify a link).
    also: (how: string) =>
      `Also: other calls merged into this link were joined by ${how}, not read from code at both ends; open either end to see them one by one.`,
    alsoHow: {
      person: "a person's pairing (their word)",
      ai: "the AI's pairing (no person has confirmed it)",
      path: "their path alone",
      "base-path": "the proxy's BasePath, their host unknown",
      label: "their host's first part",
      "platform-setting": "a platform-wide setting",
      "folder-name": "the folder a setting is in",
      conflict: "a host the manifest disagrees with",
      "service-name": "a Service's short name",
    } as Record<string, string>,
    // ADR 0192: a build dependency on a library another repo of the estate publishes.
    dependency: {
      edge: "depends on",
      intro:
        "Each build dependency on this link: the component's build file declares the coordinates the library's build publishes. It isn't a call, so it is never counted with the calls; the library's own calls stay the library's.",
      title: (from: string, to: string, coordinates: string) =>
        `${from} depends on ${to}: ${coordinates}`,
      ends: (from: string, to: string) => `${from} depends on ${to}`,
      count: (n: number) => `${n} build dependenc${n === 1 ? "y" : "ies"}`,
      scope: (scope: string) => `(${scope} scope)`,
      caller: "Declared in its build file",
      callee: "Published by",
      wrongOf: (link: string) => `Say the dependency ${link} is wrong`,
      wrongTitle: (link: string) => `What is wrong with ${link}?`,
      wrongIntro:
        "Say why it is no dependency on the estate's library (a test helper, a stale line, a fork). Atticus writes it to the depending repo's corrections file through the local API; atticus verify leaves the dependency out every time it runs, and the link goes. Nothing changes until you run the command below and the change is reviewed in a pull request.",
      reason: "Why (required)",
      needReason: "Say why the dependency is wrong first.",
      // Beta.25: a link that rests on several dependency facts (two module poms, a profile, two
      // configurations): each is listed, every one chosen at first.
      pickFacts: (n: number) =>
        `The ${n} lines of its build that declare it (the link goes once each is wrong)`,
      needFact: "Choose at least one line that declares the dependency.",
      // Beta.25: a merged arrow's every dependency, read when the view lists only some.
      moreLoading: "Reading every dependency on this arrow…",
      moreFailed: (why: string) => `Couldn't read every dependency on this arrow: ${why}`,
      noFact: (repo: string) =>
        `No dependency fact of ${repo} is on this line, so there is nothing to correct here. Read the repo again (/atticus-map ${repo}) or correct the line's facts from its citation.`,
      loadingFacts: "Reading the depending repo's facts…",
      factsFailed: (why: string) => `Couldn't read the depending repo's facts: ${why}`,
      will: (from: string, to: string) =>
        `The dependency is left out: ${from} no longer depends on ${to} once atticus verify runs with --write, unless another line of its build declares it.`,
      // Review of beta.25: the lines chosen are corrected in one write, all or none.
      savedAll: (n: number, files: string) =>
        `Written ${n} correction${n === 1 ? "" : "s"} to ${files}, in one go.`,
      alreadyAll: "Every one of these corrections is on file already, so nothing new was written.",
      skippedAll: (n: number) => `${n} ${n === 1 ? "was" : "were"} on file already.`,
    },
    // C2: this link is wrong
    wrong: "This link is wrong",
    wrongOf: (call: string) => `Say the call ${call} is wrong`,
    wrongTitle: (call: string) => `What is wrong with ${call}?`,
    wrongIntro:
      "Your word outranks every join rule. Atticus writes it to the caller's repo's corrections file through the local API; atticus verify applies it every time it runs. Nothing changes until you run the command below and the change is reviewed in a pull request.",
    pickCall: "The call on that line",
    choice: {
      estate: "It calls another repo or component of the estate",
      outside: "It calls an outside system (a vendor, a cloud service)",
      "not-a-call": "It isn't a call",
    } as Record<string, string>,
    target: "What it calls",
    targetHint: "A repo or component id, as the manifest names it.",
    outsideTarget: "The outside system",
    outsideHint: "The system's name, e.g. Northwind Pay.",
    reason: "Why (required when it isn't a call)",
    reasonOptional: "Why (optional)",
    save: "Write the correction",
    saving: "Writing the correction…",
    needTarget: "Say what it calls first.",
    sameTarget: "The call names that already: pick another target.",
    needReason: "Say why it isn't a call first.",
    noCall: (repo: string) =>
      `No call fact of ${repo} is on this line, so there is nothing to correct here. Read the repo again (/atticus-map ${repo}) or correct the line's facts from its citation.`,
    loadingFacts: "Reading the caller's facts…",
    factsFailed: (why: string) => `Couldn't read the caller's facts: ${why}`,
    will: {
      moves: (from: string, was: string, to: string) =>
        `This call leaves ${from} → ${was} and goes to ${to}: verify joins it to the entry of ${to} that serves it, or says none does.`,
      outside: (from: string, was: string, to: string) =>
        `This call leaves ${from} → ${was} and goes to ${to}, outside the estate: no repo is joined to it.`,
      unknown: (to: string) =>
        `Atticus doesn't know ${to} as a repo or component of the estate, so verify will take it as outside.`,
      dropped: (from: string, was: string) =>
        `The call is dropped from the catalog: ${from} → ${was} loses it, and goes if it was the link's only call.`,
    },
    saved: (file: string) => `Written to ${file}.`,
    // Beta.24: this whole arrow is wrong, one correction for every call on it.
    arrow: {
      open: "All calls on this arrow are wrong…",
      openOf: (link: string) => `Say every call on ${link} is wrong`,
      title: (n: number) => `What is wrong with the ${n} call${n === 1 ? "" : "s"} on this arrow?`,
      intro:
        "One answer for every call on the arrow: Atticus writes a correction for each to its caller's repo's corrections file, one write per repo. Your word outranks every join rule. Nothing changes until you apply them (Corrections to apply, at the top of the map) and the change is reviewed in a pull request.",
      choice: {
        estate: "They all go to another box (a repo or component of the estate)",
        outside: "They all go to an outside system",
        "not-a-call": "None of these is a call",
      } as Record<string, string>,
      target: "The box they all go to",
      outsideTarget: "The outside system they all go to",
      save: (n: number) => `Correct all ${n} call${n === 1 ? "" : "s"}`,
      saving: "Writing the corrections…",
      noCalls:
        "No call fact is cited on these calls' lines, so there is nothing to correct here. Read the callers' repos again, or correct each call from its citation.",
      missing: (n: number) =>
        `${n} call${n === 1 ? " has" : "s have"} no call fact on its line and ${n === 1 ? "is" : "are"} left as ${n === 1 ? "it is" : "they are"}.`,
      saved: (n: number, files: string) =>
        `Written ${n} correction${n === 1 ? "" : "s"} to ${files}.`,
      apply:
        "Next: Apply them from Corrections to apply, at the top of the map, then propose the change for review.",
      // Review of beta.24: what the arrow's correction leaves alone, and a second ask.
      loadingCalls: "Reading every call on this arrow…",
      callsFailed: (why: string) => `Couldn't read every call on this arrow: ${why}`,
      declared: (n: number) =>
        `${n} of these link${n === 1 ? " is" : "s are"} a person's declaration, not a call in code, and ${n === 1 ? "is" : "are"} left as ${n === 1 ? "it is" : "they are"}: withdraw a declaration from This link is wrong under its call.`,
      /**
       * Review of beta.24, round 4: a line that holds no call of its link's path, or more than
       * one (two hosts, another arrow's call), is never settled by a guess: the person ticks.
       */
      pick: {
        legend: "Which of these calls are on this arrow?",
        intro:
          "Atticus can't tell for sure which call on these lines makes this arrow: the line holds no call of its path, or more than one. Tick each call that belongs to this arrow; only the ticked ones are corrected.",
        call: (what: string, host: string | undefined, at: string) =>
          `${what}${host ? ` to ${host}` : ""}, ${at}`,
        need: "Tick at least one call to correct first.",
      },
      /** Review of beta.24, round 3: more calls than one request corrects. */
      tooMany: (n: number, max: number) =>
        `This arrow has ${n} calls to correct, more than the ${max} one correction can take. Correct the calls of one box at a time, opening the arrow from a box inside it.`,
      routing: (n: number) =>
        `${n} of these link${n === 1 ? " comes" : "s come"} from a gateway proxy's routing, with no line of a caller's to correct, and ${n === 1 ? "is" : "are"} left as ${n === 1 ? "it is" : "they are"}: correct the proxy's forwarding on the proxy's own box, which changes that route for every caller.`,
      already:
        "Every one of these corrections is on file already, so nothing new was written. Apply them from Corrections to apply, at the top of the map.",
      skipped: (n: number) =>
        `${n} ${n === 1 ? "was" : "were"} on file already and ${n === 1 ? "was" : "were"} left as ${n === 1 ? "it was" : "they were"}.`,
    },
    // Review of beta.24: a link with no line of a caller's has nothing of its own to correct.
    declaredLink: {
      profile: "the profile",
      say: (file: string) =>
        `A person declared this link in ${file}: no call in code makes it, so there is no call to correct. Withdraw the declaration and the link goes at the next join.`,
      sayNoFile:
        "A person declared this link in the profile: no call in code makes it, so there is no call to correct. Withdraw the declaration and the link goes at the next join.",
      byHand: (file: string) =>
        `It wasn't declared from the canvas, so there is no Undo for it here: remove it from ${file} and propose that for review.`,
    },
    routingLink:
      "No line of a caller's cites this call: the link comes from a gateway proxy's routing, and correcting the proxy's forwarding changes the route for every caller, not this link alone. To do that, open the proxy's own box and correct its forwarding there (Correct this at its line).",
    moved: "What moved when the estate was joined again",
    movedTo: (what: string, was: string, now: string) => `${what}: was ${was}, now ${now}`,
    movedOff: (what: string, was: string) =>
      `${what}: was ${was}, now on no link of the parts open here`,
    notYet:
      "No call has moved yet: run the verify command above. The picture reads the catalog again when it changes.",
  },
  /** ADR 0124 addendum D-app, B10: a stage tab's critic findings, their options and a comment box. */
  stageReview: {
    title: "What the critic found",
    intro:
      "The critic's findings on this stage's latest draft, each with what you can do about it: make the fix, say it isn't relevant, waive it where the rule allows, or ask its owner. Or leave a comment: the stage's next run gives it to your assistant as your answer, with the next draft.",
    notRun:
      "This stage hasn't run for this change yet, so there is nothing to review. Run it first:",
    noRound: (gate: string | null) =>
      gate
        ? `The critic hasn't reviewed a draft at the ${gate} gate yet. The stage runs it on each draft that passes its checks.`
        : "No gate in gates.yaml reviews this stage's phase, so the critic doesn't run here.",
    clean: (gate: string, round: number) => `Nothing found at the ${gate} gate, round ${round}.`,
    round: (gate: string, round: number, n: number) =>
      `${n} finding${n === 1 ? "" : "s"} at the ${gate} gate, round ${round}`,
    loopState: {
      drafting: "The stage is drafting.",
      waiting: "The stage waits on your assistant's answer.",
      questions: "The stage waits on the questions below.",
      stopped: "The stage stopped: its assistant couldn't fix what was found.",
      done: "The stage is done.",
    } as Record<string, string>,
    severity: {
      blocking: "Blocking",
      gap: "Knowledge gap",
      risk: "Risk",
      idea: "Idea",
    } as Record<string, string>,
    state: {
      open: "Open",
      applied: "Fixed",
      dismissed: "Not relevant",
      waived: "Waived",
      asked: "Asked",
    } as Record<string, string>,
    where: "Where",
    why: "Why",
    fix: "The fix",
    options: "What you can do",
    apply: "Make the fix",
    applyFor: (id: string) => `Make the fix for ${id}`,
    dismiss: "Not relevant",
    dismissFor: (id: string) => `Not relevant: ${id}`,
    waive: "Waive",
    waiveFor: (id: string) => `Waive ${id}`,
    ask: (owner: string) => `Ask ${owner}`,
    askFor: (id: string, owner: string) => `Ask ${owner} about ${id}`,
    cantWaive: "This rule can't be waived: fix it, or say it isn't relevant with why.",
    reason: (id: string) => `Why, for ${id} (needed for not relevant and waive)`,
    needReason: "Write why first: not relevant and waive need a reason.",
    acted: (action: string) => `Recorded: ${action}.`,
    actions: {
      apply: "the fix is made",
      "not-relevant": "not relevant",
      waive: "waived",
      // ADR 0191: where notifications are set up, it is sent from Questions › Owner questions.
      ask: "asked of its owner: send it to them from Questions › Owner questions",
    } as Record<string, string>,
    resolved: (state: string, by: string) => `${state} by ${by}`,
    // ADR 0115 addendum (2026-10-25): an assistant only proposes; a person closes the finding.
    proposed: (by: string, claim: string) =>
      `Proposed by the assistant (${by}) as ${claim === "fixed" ? "fixed" : "not relevant"}, waiting on a person`,
    question: (owner: string) => `The question for ${owner}`,
    comments: "Comments",
    comment: (id: string) => `Your comment on ${id}`,
    commentHint:
      "Say what the next draft should do about it. Your words go to the assistant as your answer.",
    saveComment: "Save the comment",
    savingComment: "Writing the comment…",
    needComment: "Write the comment first.",
    read: "read by a draft",
    unread: "not read yet: run the stage",
    commented: (files: string) =>
      `Written to ${files}. Commit them, then run the stage again: its next draft reads your comment.`,
    copyCommit: "Copy the git command",
    questions: "The stage's questions",
    noQuestions: "The stage has no question for a person.",
    answered: (words: string) => `Answered: ${words}`,
    answerIt: (q: string) => `Answer: ${q}`,
    next: "Then run the stage again",
    nextWhy:
      "It reads your answers, comments and choices, drafts again where they ask, and the critic checks the new draft.",
    /** Eighth UX walk: a stage that is done offers a fresh run only under a disclosure. */
    runAgain: "Run the stage again",
    runAgainWhy:
      "The stage is done. Run it again only to redraft: it reads your answers and comments, and the critic checks the new draft.",
    pickForArchitecture: "Pick a change to see what the critic found in its architecture.",
  },
  /** ADR 0189: a stage of a change as one conversation, on the stage's tab. */
  thread: {
    title: (stage: string) =>
      ({
        proposal: "The proposal, as one conversation",
        feature: "The feature stage, as one conversation",
        architecture: "The architecture stage, as one conversation",
        stories: "The stories stage, as one conversation",
        small: "The small change, as one conversation",
      })[stage] ?? "The stage, as one conversation",
    intro:
      "Everything about this stage in one place, in order: the prompt for your assistant, its answer and what the checks said, what the critic found, the questions, and what you told the assistant. Your assistant does the work in your editor; you paste the prompt, and the app picks the answer up as soon as the file is written.",
    loading: "Reading the stage's thread…",
    start: "Start the stage",
    startNext: "Start the next round",
    starting: "Writing the prompt…",
    prompt: "The prompt for your assistant",
    criticPrompt: "The critic's prompt for your assistant",
    copyPrompt: "Copy the prompt",
    copyPromptFor: (run: string) => `Copy the prompt of ${run}`,
    showPrompt: "Show the prompt",
    pasteHint:
      "Paste it into your assistant (Copilot or Claude Code). It writes the answer file; the app checks it as soon as the file is complete.",
    runState: {
      prepared: "Ready to paste",
      waiting: "Waiting for the answer",
      produced: "Being checked",
      validated: "Answered",
      failed: "Answered, with problems",
      cancelled: "Not used: a newer prompt replaced it",
    } as Record<string, string>,
    answer: "Your assistant's answer",
    criticAnswer: "The critic's answer",
    checked: {
      passed: "Passed the checks",
      failed: "Didn't pass the checks",
      checking: "Being checked",
    } as Record<string, string>,
    checkedBy: {
      app: "The app checked it when the file arrived.",
      person: "Checked when Done was pressed.",
    } as Record<string, string>,
    problems: "What the checks found",
    changed: "What the stage wrote",
    finding: "The critic found",
    where: (at: string) => `At ${at}`,
    fix: "The fix",
    reply: "Reply",
    replyFor: (id: string) => `Reply about ${id}`,
    makeFix: "Make the fix",
    makeFixFor: (id: string) => `Make the fix for ${id}`,
    fixToAssistant: (fix: string) => `Make the fix: ${fix}`,
    fixSent:
      "Sent to the assistant: the next round makes the fix. Start the next round when you're ready.",
    fixInEditor: (file: string) =>
      `The stage's assistant doesn't write ${file}, so the fix is yours: it opens here, at the line.`,
    fixSaved: "Saved. Recorded as fixed.",
    askOwner: (owner: string) => `Ask ${owner}`,
    askOwnerFor: (id: string, owner: string) => `Ask ${owner} about ${id}`,
    asked: "Asked of its owner.",
    notRelevant: "Not relevant, for this reason",
    notRelevantNeeds: "Write why it isn't relevant in the box first.",
    findingState: {
      open: "Open",
      applied: "Fixed",
      dismissed: "Not relevant",
      waived: "Waived",
      asked: "Asked",
    } as Record<string, string>,
    question: "A question for a person",
    answerHere: (q: string) => `Answer: ${q}`,
    answered: (words: string) => `Answered: ${words}`,
    you: (by: string) => `${by} told the assistant`,
    aboutFinding: (id: string) => `About ${id}`,
    read: "Read by a round",
    unread: "The next round reads it",
    correction: (label: string) => `Correction of ${label}`,
    dropped: "1 question couldn't be kept: its line didn't match",
    droppedCites: (at: string) => `It cites ${at}.`,
    droppedNearest: (at: string) => `Keep it anyway cites ${at}, the nearest line.`,
    droppedNone: "Keep it anyway cites the stage's file: no file it names is there.",
    keep: "Keep it anyway",
    keepFor: (q: string) => `Keep it anyway: ${q}`,
    kept: "Kept: it is one of the stage's questions now.",
    note: "Note",
    replyLabel: "Tell the assistant…",
    replyAbout: (id: string) => `Tell the assistant about ${id}…`,
    replyHint:
      "Say what the next round should do. Your words go to the assistant with the next prompt, as your answer.",
    send: "Send and start the next round",
    sendOnly: "Send",
    sending: "Sending…",
    needText: "Write what to tell the assistant first.",
    clearAbout: "Not about a finding",
    sent: "Sent. The next round's prompt carries it.",
    savedNotStarted: (why: string) =>
      `Your reply is saved, but the next round didn't start: ${why} Press Start the next round once that is fixed; there's no need to send the reply again.`,
    replyClosed: "Replies open once the stage has run.",
    details: "Details",
    detailAgent: (agent: string, runtime: string) => `Step ${agent}, ${runtime}`,
    detailTokens: (n: number) => `${n} tokens`,
    detailModel: (m: string) => `Model ${m}`,
    detailAttempt: (n: number) => `Round ${n}`,
    detailFiles: "Files",
    adminView: "Every run, for an administrator: Set up › Model runs",
    empty: "Nothing has happened at this stage yet.",
    criticRan: (waiting: number) =>
      waiting
        ? `The rule checks ran; ${waiting === 1 ? "an AI lens waits" : `${waiting} AI lenses wait`} for your assistant in the stage's thread.`
        : "The rule checks ran.",
  },
  /** ADR 0181 part 4: each role answers its own questions on a change. */
  roles: {
    names: {
      product: "Product",
      architecture: "Architecture",
      analysis: "Analysis",
      delivery: "Delivery",
    } as Record<string, string>,
    who: {
      product: "the product owner",
      architecture: "the architect",
      analysis: "the business analyst",
      delivery: "the tech lead",
    } as Record<string, string>,
    filter: "Role",
    allRoles: "All roles",
    option: (name: string, open: number | undefined, yours: boolean) =>
      `${name}${open !== undefined ? ` (${open})` : ""}${yours ? " · yours" : ""}`,
    pickYours: "Your role",
    pickYoursHint:
      "The change doesn't name you among its owners, so pick the role you play: Atticus remembers it on this machine. Or name the change's owners on its page.",
    /** Ninth UX walk: some changes in flight name the person, so the pick covers the others. */
    pickYoursHintSome:
      "For the changes that don't name you among their owners, pick the role you play: Atticus remembers it on this machine. Where a change names you, its owners decide.",
    pickNone: "Pick a role",
    homeTitle: "Your role's questions",
    homeIntro:
      "Each role answers its own questions on a change: the product owner the brief's, the architect the feature stage's (placing it on the estate) and the design's, the business analyst the stories', the tech lead the tasks'.",
    line: (change: string, role: string, open: number) =>
      open === 0
        ? `${change}: no open question for ${role}.`
        : `${change}: ${open} open ${open === 1 ? "question" : "questions"} for ${role}.`,
    fromOwners: "From the change's owners",
    fromPicker: "The role you picked",
    open: "Answer them",
    noChanges: "No change in flight asks a role anything yet.",
    cantRead: (change: string) => `The questions of ${change} couldn't be read.`,
  },
  /** Ninth UX walk: name a change's owners per role, on its page. */
  changeOwners: {
    title: "Owners by role",
    intro:
      "Who answers each role's questions on this change. Saving writes change.yaml's owners; it rides the change's next hand-off.",
    roles: {
      "product-owner": "Product owner",
      architect: "Architect",
      "business-analyst": "Business analyst",
      "team-lead": "Tech lead",
    } as Record<string, string>,
    placeholder: "Git handles, comma-separated",
    save: "Save owners",
    saving: "Saving…",
    saved: "Saved the owners in change.yaml.",
  },
  /** ADR 0181 part 4: Run all ready tasks, on the Task board. */
  runReady: {
    button: "Run all ready tasks",
    buttonCount: (n: number) => `Run all ready tasks (${n})`,
    running: "Running the ready tasks…",
    reading: "Reading which tasks are ready…",
    cantRead: (why: string) => `Which tasks are ready couldn't be read: ${why}`,
    why: "The tech lead or architect runs the tasks: every task whose dependencies are done, in cross-repo order, one task run each, stopping on the first that needs a person. Your click approves the drafts; each PR is raised on its own Raise click, and nothing is merged.",
    noneReady:
      "No task is ready to run: each waits for the tasks before it, its PR, the assistant or a person.",
    progress: (message: string) => `Running: ${message}`,
    ran: (task: string, state: string) => `Task ${task}: ${state}`,
    refused: (task: string, why: string) => `Task ${task} wasn't run: ${why}`,
    stopped: (task: string, why: string, left: string) =>
      `Stopped at task ${task}: ${why}.${left ? ` Not run yet: ${left}.` : ""}`,
    allRan: (n: number) =>
      `Ran ${n} ${n === 1 ? "task" : "tasks"}. A person reviews and merges each PR on the Git host.`,
    failed: "The ready tasks couldn't be run.",
    waits: (task: string, why: string) => `Task ${task} isn't ready: ${why}.`,
  },
  /**
   * ADR 0181 (stage drafts): AI decides first, a person corrects, and the AI corrects the rest
   * like it. Each stage draft says who wrote it last, and every item has Correct.
   */
  stageDrafts: {
    title: "The drafts",
    intro:
      "What the AI drafted for this stage. Read each one: if something is wrong, Correct it in your words. The stage's next run follows your correction, and with Apply to similar, makes the same fix everywhere it fits.",
    none: "Nothing drafted for this page yet. Run the stage: its drafts show here, each marked as drafted by AI until you edit it.",
    draftedByAi: "Drafted by AI",
    draftedByAiRun: (run: string) => `in run ${run}`,
    draftedByAiWhy: (stage: string) =>
      `Drafted by AI at the ${stage} stage; no person has edited it since. Read it before the hand-off.`,
    editedBy: (who: string, day: string) => `Edited by ${who} on ${day}`,
    editedByPerson: "Edited by a person",
    editedOutside: "Changed outside the app since the AI drafted it.",
    openRun: (run: string) => `Open run ${run}`,
    items: (file: string) => `What you can correct in ${file}`,
    correct: "Correct",
    correctFile: (file: string) => `Correct ${file} as a whole`,
    correctItem: (label: string) => `Correct ${label}`,
    formTitle: (label: string) => `Your correction of ${label}`,
    textLabel: "What should it say or do instead?",
    textHint:
      "Say it as you would to a colleague. Your words go to the stage's assistant as your instruction; a fact verified from the code still wins over them.",
    similar: "Apply to similar",
    similarHint:
      "The next run makes the same correction to every other step, story, section or task like this one.",
    likeLabel: "Similar items name",
    likeHint:
      "The component, entry, table or term they share. Leave it empty to let the run judge.",
    save: "Save the correction",
    saving: "Writing the correction…",
    cancel: "Cancel",
    needText: "Write the correction first.",
    saved: (label: string) =>
      `Your correction of ${label} is saved. Run the stage again to apply it.`,
    waitingTitle: "Corrections waiting for the next run",
    waitingNone: "No correction waits. Correct an item above, then run the stage again.",
    runAgain: "Run the stage again to apply them",
    runAgainWhy:
      "The stage's next run reads every correction as your instruction, drafts again from the current drafts, and the critic checks the new draft.",
    doneTitle: "Corrections the stage has read",
    state: {
      waiting: "Waiting for the next run",
      read: "Read, but the item didn't change",
      applied: "Applied",
    } as Record<string, string>,
    scope: {
      one: "This item",
      similar: "This item and similar ones",
    } as Record<string, string>,
    likeOf: (like: string) => `naming ${like}`,
    by: (who: string, day: string) => `${who}, ${day}`,
    appliedIn: (run: string) => `in run ${run}`,
    touched: (n: number) => `Also changed ${n} similar item${n === 1 ? "" : "s"}:`,
    readNotApplied:
      "The draft had your correction but didn't change this item. Correct it again in other words, or edit the file.",
    remove: "Take back",
    removeFor: (label: string) => `Take back your correction of ${label}`,
    removed: "Correction taken back.",
    copyCommit: "Copy the git command",
    /** Ninth UX walk: the corrections file goes with the stage's hand-off, no git in the app. */
    ridesHandoff: (file: string) =>
      `It is kept in ${file}, which goes with the stage's hand-off: running the stage again and raising its hand-off carries it to the pull request.`,
    outsideHandoff: "Not raising this stage's hand-off? Propose the file for review:",
    correctionsFile: "the change's stage/corrections.yaml",
  },
  /**
   * ADR 0181 parts 1 to 3 (screens): AI decides first, as itself; a person corrects one, and the
   * correction spreads to everything like it; every batch is one Undo away.
   */
  decisions: {
    chip: "Detected by AI",
    /** Spoken after the chip: what it means, so the chip is never colour alone. */
    chipWhy:
      "Decided by AI as itself, through an Atticus run (a Copilot session Atticus started, or a hand-off to your assistant read back on Done). No person has confirmed it; correct it if it is wrong.",
    /** The batch rows' chip: its words alone (the page says once what it means). */
    chipShort: "By AI",
    run: (run: string) => `run ${run}`,
    openRun: (run: string) => `Open run ${run}: what the AI was asked and what it answered`,
    title: "Decided by AI",
    intro:
      "What the AI decided without a person: pairings of calls to APIs and answers to option questions. Each is the AI's, never yours. If one is wrong, Correct it: your answer is your word, and Apply to similar spreads it to everything like it. Every batch is one Undo away.",
    loading: "Reading the AI's decisions…",
    failed: (why: string) => `The AI's decisions couldn't be read: ${why}`,
    problems: "Files that couldn't be read:",
    /** How the links or questions were settled, three ways. */
    counts: {
      label: (what: string) => `How the ${what} were settled`,
      links: "links",
      questions: "questions",
      line: (c: {
        fromCode: number;
        byPerson: number;
        byAi: number;
        open?: number | undefined;
        retired?: number | undefined;
      }) =>
        c.retired !== undefined
          ? `${c.byPerson} by a person · ${c.byAi} by AI${c.open !== undefined ? ` · ${c.open} open` : ""} · ${c.retired} retired`
          : `${c.fromCode} from code · ${c.byPerson} by a person · ${c.byAi} by AI${c.open !== undefined ? ` · ${c.open} open` : ""}`,
      /** Ninth UX walk: the catalog's links are the map as last applied, apart from the lines. */
      linksInMap: "links in the map as last applied",
      lines: (byAi: number, byPerson: number) =>
        `The corrections hold ${byAi} standing AI pairing${byAi === 1 ? "" : "s"} and ${byPerson} of people's now; Apply brings the map up to them.`,
    },
    mode: {
      auto: "decided by AI",
      propose: "proposed for a person",
    } as Record<string, string>,
    modeLine: (links: string, questions: string) =>
      `Now: pairings are ${links}; option answers are ${questions}.`,
    /** Ninth UX walk: where deciding happens, as runtime.yaml allows the runs. */
    decideIn: {
      none: "runtime.yaml allows neither copilot-acp nor hand-off here, so no run decides anything: the AI only proposes.",
      both: "The AI decides when a Copilot session Atticus runs ends, and when a hand-off to your assistant is marked done (Match with Copilot's Read the answer, Ask AI to propose's Done).",
      handoff:
        "The AI decides when a hand-off to your assistant is marked done (Match with Copilot's Read the answer, Ask AI to propose's Done); copilot-acp isn't allowed here.",
      acp: "The AI decides when a Copilot session Atticus runs ends; hand-off isn't allowed here.",
    },
    setUp: "Change it in Set up › AI",
    kind: { link: "Pairing", question: "Answer" } as Record<string, string>,
    filterRepo: "Repo",
    allRepos: "All repos",
    filterKind: "Kind",
    allKinds: "Pairings and answers",
    kinds: { link: "Pairings", question: "Answers" } as Record<string, string>,
    itemsTitle: "What the AI decided",
    itemsCaption: "Each decision the AI applied that still stands",
    itemsEmpty:
      "The AI has decided nothing that still stands. When runtime.yaml's decide says auto, Match with Copilot and Ask AI to propose apply what passes the bar here.",
    itemsFiltered: "Nothing the AI decided matches the filter.",
    shown: (n: number, total: number) =>
      n === total ? `${total} decision${total === 1 ? "" : "s"}` : `${n} of ${total} decisions`,
    decided: (what: string) => `Decided: ${what}`,
    bar: {
      confident: "it met the confidence bar",
      "agrees-with-shapes": "it agrees with what the code's shapes say",
      "person-rule": "it agrees with a person's rule",
    } as Record<string, string>,
    because: (bar: string) => `Applied because ${bar}.`,
    restsOn: "Rests on",
    question: "Question",
    /** Correct one, and Apply to similar. */
    correct: "Correct",
    correctOf: (what: string) => `Correct: ${what}`,
    formTitle: (what: string) => `Your correction of ${what}`,
    pickOption: "The right answer",
    pickLink: "Where the call really goes",
    linkApi: "This API",
    noneOption: "None of these",
    noneLink: "The call reaches none of these",
    repoLabel: "Repo the API is in",
    repoPick: "Pick the repo",
    apiLabel: "API",
    apiPick: "Pick the API",
    apisLoading: "Reading that repo's APIs…",
    apisFailed: (why: string) => `That repo's APIs couldn't be read: ${why}. Type the API's id:`,
    apiIdLabel: "The API's id (its entry fact)",
    similar: "Apply to similar",
    similarHint:
      "Atticus derives a rule from your correction, shows it below before you save, and re-checks every AI decision and open item it covers in this repo.",
    matchLabel: "The rule to spread (a path prefix, host or topic pattern)",
    matchHint: "Atticus derived it; change it to spread wider or narrower.",
    matchHintNone:
      "Atticus derives one when you preview; where it can't, give one here (a path prefix such as /forge/limits/**, a host pattern or a topic pattern).",
    preview: "Preview",
    previewing: "Working out what it changes…",
    save: "Save my correction",
    saving: "Writing your correction…",
    cancel: "Cancel",
    needPick: "Pick the right answer first.",
    needApi: "Pick the API and say its repo, or pick None of these.",
    previewFirst:
      "Preview first: you see the rule and what it spreads to before anything is saved.",
    changedSince: "The correction changed since the preview. Preview it again.",
    approval:
      "Saving is your approval: the correction is recorded as your word, and its rule as yours.",
    previewTitle: "What saving does",
    yourAnswer: (a: string) => `Your answer: ${a}`,
    rule: (kind: string, match: string, derived: boolean) =>
      derived ? `The rule derived from it (${kind}): ${match}` : `Your rule (${kind}): ${match}`,
    noRule: (why: string) => `No rule spreads: ${why}`,
    spreadNone: "No other item is like it: only this one changes.",
    spreadTitle: (n: number) => `${n} other item${n === 1 ? "" : "s"} the rule re-checks`,
    spreadCaption: "What the rule does to each item like it",
    change: {
      applied: "Applied",
      confirmed: "Confirmed",
      replaced: "Replaced",
      reverted: "Reverted to open",
    } as Record<string, string>,
    changeWhy: {
      applied: "an open item your rule answers",
      confirmed: "the AI had decided the same",
      replaced: "the AI had decided otherwise; your rule decides",
      reverted: "the AI had decided otherwise and your rule can't decide it, so it is open again",
    } as Record<string, string>,
    col: { item: "Item", change: "What happens", was: "Was", now: "Now" },
    spreadCounts: (c: { applied: number; confirmed: number; replaced: number; reverted: number }) =>
      `${c.applied} applied, ${c.confirmed} confirmed, ${c.replaced} replaced, ${c.reverted} reverted to open.`,
    nothing: "—",
    saved: (answer: string) => `Saved as your word: ${answer}.`,
    savedBatch: (batch: string) =>
      `Written as batch ${batch}, one Undo away on Map › Decided by AI.`,
    whatSpread: "What your correction spread to",
    savedFlash: (
      answer: string,
      c: { applied: number; confirmed: number; replaced: number; reverted: number },
    ) =>
      `Your correction is saved as your word: ${answer}. Similar items: ${c.applied} applied, ${c.confirmed} confirmed, ${c.replaced} replaced, ${c.reverted} reverted to open.`,
    verify: "Bring the map up to it:",
    commit: "Commit it for review:",
    /** Ninth UX walk: the next steps as the app's own buttons; the commands under Or in a terminal. */
    next: "Then bring the map up to it, and propose it for review:",
    terminal: "Or in a terminal",
    copy: (cmd: string) => `Copy: ${cmd}`,
    makeRuleOffer: (n: number, shape: string) =>
      `This shape has been corrected ${n} times (${shape}). Make it a reading rule, so the next read gets it right at the source.`,
    makeRule: "Make this a reading rule",
    makingRule: "Drafting the reading rule…",
    ruleMade: (file: string) => `Drafted the reading rule in ${file}. Turn it on with:`,
    ruleCommand: "Draft it in a terminal:",
    /** Batches and Undo. */
    batchesTitle: "Batches",
    batchesIntro:
      "Every batch the AI or a person's rule applied, newest first. Undo removes exactly its lines and answers, and puts back what it took away.",
    batchesEmpty: "No batch yet: nothing has been applied by AI or by a correction's rule.",
    batchesCaption: "Batches applied, newest first, each with Undo",
    batchKind: {
      ai: "By AI",
      rule: "By a person's rule",
      correction: "A person's correction",
    } as Record<string, string>,
    batchCol: { batch: "Batch", by: "Who and when", what: "What it did", undo: "Undo" },
    batchBy: (by: string, day: string) => `${by}, ${day}`,
    batchApplied: (applied: number, reverted: number) =>
      `${applied} applied${reverted ? `, ${reverted} reverted to open` : ""}`,
    batchFrom: (item: string, answer: string) => `From the correction of ${item}: ${answer}`,
    batchRule: (kind: string, match: string) => `Rule (${kind}): ${match}`,
    undone: (by: string, day: string) => `Undone by ${by} on ${day}`,
    undo: "Undo",
    undoOf: (id: string) => `Undo batch ${id}`,
    confirmUndo: (id: string, applied: number) =>
      `Undo batch ${id}? It removes the ${applied} line${applied === 1 ? "" : "s"} and answer${applied === 1 ? "" : "s"} it applied and puts back what it took away. Anything changed since is left as it is now.`,
    confirmYes: "Yes, undo it",
    confirmNo: "Keep it",
    undoing: "Undoing…",
    undoneResult: (batch: string, removed: number, restored: number) =>
      `Batch ${batch} undone: removed ${removed}, put back ${restored}.`,
    skipped: "Left as it is now, because it changed since the batch:",
    undoFailed: (why: string) => `The batch couldn't be undone: ${why}`,
    record: (file: string) => `Record: ${file}`,
    /** Home and Map › Trust. */
    pausedTitle: "AI deciding is paused",
    pausedWhy: (why: string) =>
      `${why} Until the audit is back above the bar, the AI only proposes.`,
    pausedLink: "See the audit on Map › Trust",
    trustTitle: "AI decisions",
    trustTally: (t: {
      right: number;
      wrong: number;
      precision: number | null;
      low: number | null;
      high: number | null;
    }) =>
      t.precision === null
        ? "AI decisions: no audited answers yet"
        : `AI decisions: ${Math.round(t.precision * 100)}% right (${t.right} of ${t.right + t.wrong}; 95% between ${Math.round((t.low ?? 0) * 100)}% and ${Math.round((t.high ?? 0) * 100)}%)`,
    trustBar: (min: number) =>
      `The bar is ${Math.round(min * 100)}%: below it, the AI stops deciding and only proposes.`,
    trustOpen: "Open Decided by AI",
    trustAudit: "ai decisions",
    /** A change's impact. */
    impactByAi: (n: number) =>
      `${n} of the callers that break ${n === 1 ? "is" : "are"} linked only by AI; confirm or correct ${n === 1 ? "its link" : "their links"} on Decided by AI.`,
    impactCaller: "every link of this caller was decided by AI",
    /** The AI's answer on a question, beside who answered. */
    answeredByAi: (day: string) => `Answered by AI on ${day}`,
    /** Match with Copilot: what Atticus applied as the AI's. */
    matchApplied: (n: number) =>
      `Atticus applied ${n} pairing${n === 1 ? "" : "s"} as the AI's (they met the bar):`,
    matchKept: (n: number) => `${n} kept as proposals for you:`,
    matchPaused: (why: string) => `Not applied: AI deciding is paused. ${why}`,
    matchUndo: "Undo or correct them on Decided by AI",
    /** The Connect panel: what the AI already paired between the two boxes. */
    betweenTitle: (n: number) => `Paired by AI between these boxes (${n})`,
    /** Why is this linked?: a link the AI decided. */
    whyLinked:
      "The AI paired this call with this entry, from a run Atticus started. No person has confirmed it, so it is inferred until someone does.",
  },
  /** ADR 0190: settings and setup in the app, "Edit, then Propose". */
  setup: {
    // Create the metarepo here, or open another folder.
    title: "Set up Atticus here",
    intro: (root: string) =>
      `${root} isn't a metarepo yet. Create one here, or open the folder of one you have.`,
    loading: "Looking at this folder…",
    createTitle: "Create the metarepo here",
    createWhat:
      "Atticus writes the org pack, openspec/ and the catalog folders here, makes the folder a Git repository if it isn't one, and pushes nothing. Propose it for review once your repos are in.",
    name: "Name",
    nameHint: "A lowercase slug, such as forge-payments: the org pack's name.",
    platform: "Platform",
    platformHint: "What its repos make up, as a slug, such as forge.",
    owner: "Owner (optional)",
    ownerHint:
      "Who looks after the org pack, normally the platform lead. Left out, it is a question for later.",
    metarepoId: "The metarepo on your Git host (optional)",
    metarepoIdHint:
      "Its repo there, such as forge-payments-metarepo. Read from this folder's origin when it is a clone. Propose for review and hand-offs open their PRs on it.",
    badSlug: "A lowercase slug: letters, digits and - only, such as forge-payments.",
    create: "Create the metarepo",
    creating: "Creating…",
    created: "The metarepo is made. Next: add your repos.",
    openTitle: "Open another folder",
    path: "Folder",
    pathHint: "Its full path on this machine, such as C:\\work\\forge-metarepo.",
    open: "Open it",
    opening: "Opening…",
    openedAt: (url: string) => `Opening it at ${url}…`,
    terminal: "Or in a terminal",
    // The diff before a write, then Propose.
    preview: "Preview the change",
    previewing: "Looking…",
    willChange: (path: string) => `${path} will change:`,
    diffLabel: (path: string) => `Lines that change in ${path}`,
    removed: "removed",
    added: "added",
    nothingChanges: "Nothing would change.",
    write: "Write it",
    writing: "Writing…",
    cancel: "Cancel",
    written: (path: string) => `${path} is written.`,
    thenPropose: "Propose it for review: a person merges the PR on the Git host.",
    confirmAddress:
      "This moves where the model's key goes: Write it is your confirmation (as Save is in the AI settings).",
    // Add repos.
    reposTitle: "Add repos",
    reposIntro:
      "Paste clone URLs, one a line (up to 500 at once), or discover a folder of clones on this machine. You see the list before anything is written; then the manifest is proposed for review.",
    pasteMode: "Paste clone URLs",
    folderMode: "Discover a folder of clones",
    modeLabel: "How",
    urls: "Clone URLs",
    urlsHint:
      "As your Git host shows them, such as https://dev.azure.com/forgeorg/Forge%20Payments/_git/forge-ledger. Credentials and a browser link's ?path= are taken out.",
    dir: "Folder of clones",
    dirHint:
      "Its full path. Every repo in it is read from its files, as atticus repos discover does.",
    read: "Read the list",
    reading: "Reading…",
    platformLabel: "Platform",
    platformNone: "Choose one",
    choosePlatform: (n: number) =>
      `The org pack has ${n} platforms, and a folder's repos are one platform's: choose which, then read the folder.`,
    toAdd: (n: number) => `${n} repo${n === 1 ? "" : "s"} to add`,
    colAdd: "Add",
    colId: "Id",
    colUrl: "Clone URL",
    colType: "Type",
    colAbout: "What it is (optional)",
    addFor: (id: string) => `Add ${id}`,
    aboutFor: (id: string) => `What ${id} is`,
    normalised: (given: string) => `From: ${given}`,
    renamed: (from: string, why: string) =>
      `${from} is taken (${why}), so this one is the id shown.`,
    listed: (url: string, id: string) => `${url} is listed already, as ${id}: left out.`,
    refused: (given: string, why: string) => `${given}: ${why}.`,
    skipped: (n: number) => `${n} folder${n === 1 ? "" : "s"} looked at aren't repos.`,
    nothingNew: "Nothing new to add: the manifest lists all of them already.",
    noneTicked: "Tick at least one repo to add.",
    // A repo's type.
    detect: "Detect the type",
    detecting: "Reading its files…",
    detectFor: (id: string) => `Detect the type of ${id}`,
    detected: (type: string) => `Its files say ${type}.`,
    detectedTypes: (verdict: string, type?: string) =>
      type
        ? `The org pack's repo types: a ${verdict} match for ${type}.`
        : `The org pack's repo types: ${verdict}.`,
    noType: "Nothing in its files settles a type: set one here.",
    type: "Type",
    typeFor: (id: string) => `Type of ${id}`,
    setType: "Set the type",
    typeHint:
      "Type it prototype for a prototype repo: Change › Prototypes compares it with the estate.",
    // The outside systems.
    adaptersTitle: "Outside systems",
    adaptersIntro:
      "Where Atticus opens PRs, files work items and requests, and sends notifications. Manual: Atticus writes each step for a person with every field ready to copy, and records the result (the way to go when your Git host, ADO or ServiceNow has no API access from here). Each change is written to runtime.yaml, then proposed for review.",
    kinds: {
      gitHost: "Git host",
      workTracker: "Work tracker",
      serviceDesk: "Service desk",
      notify: "Notifications",
      wiki: "Wiki",
      design: "Design tool",
    } as Record<string, string>,
    types: {
      manual: "Manual: a step for a person",
      github: "GitHub",
      "azure-repos": "Azure DevOps (Azure Repos)",
      gitlab: "GitLab",
      bitbucket: "Bitbucket",
      "azure-devops": "Azure DevOps Boards",
      jira: "Jira",
      servicenow: "ServiceNow",
      "jira-service-management": "Jira Service Management",
      teams: "Microsoft Teams",
      slack: "Slack",
      email: "Email",
      confluence: "Confluence",
      "ado-wiki": "Azure DevOps wiki",
      sharepoint: "SharePoint",
      figma: "Figma",
      mock: "Mock (for tests)",
    } as Record<string, string>,
    notSet: "Not set",
    typeOf: (kind: string) => `${kind}: how it is reached`,
    fields: {
      metarepo: "The metarepo's repo on the Git host",
      protectedBranches: "Protected branches (one a line)",
      defaultBranch: "Default branch, when a repo doesn't say",
      project: "Project",
      idPattern: "Work item id pattern",
      numberPattern: "Request number pattern",
      exportDir: "Exported to (a folder of this metarepo)",
    } as Record<string, string>,
    fieldHints: {
      metarepo:
        "Its id there, such as forge-payments-metarepo (Azure Repos) or forge/forge-metarepo (GitHub). Propose for review and hand-offs open their PRs on it.",
      protectedBranches:
        "AI never pushes to these; the default branch always is one. Such as main and release.",
    } as Record<string, string>,
    more: "Other settings the adapter's plugin reads (name: value, one a line)",
    moreHint:
      'Values read as YAML: true, 3 and [a, b] are a yes, a number and a list; quote one to keep it words ("3"). Never a token or key: Atticus refuses one.',
    adapterChanged: (kind: string) =>
      `runtime.yaml changed since you started editing ${kind} (another window, the raw editor or the CLI). Writing this would be refused: start again from the file as it is now, or make your edit there.`,
    adapterReload: "Start again from the file",
    badLine: (line: string) => `"${line}" doesn't read as name: value.`,
    live: (type: string) =>
      `${type} is a live adapter: its plugin goes in the org pack. Until it can be reached, its steps fall back to manual ones.`,
    secretTitle: "Tokens and keys",
    secretWhy:
      "A token never goes in runtime.yaml or through the app. Keep it in this machine's credential store from your terminal, under the name the adapter's plugin reads:",
    secretCommand: "atticus secret set <NAME>",
    takeOut: "Take it out",
    kindFor: (kind: string) => `${kind}'s settings`,
    // The raw editor, the fallback.
    editInApp: "Edit in app",
    editFile: (path: string) => `Edit ${path} in the app`,
    rawTitle: (path: string) => `Edit ${path}`,
    rawHint:
      "The whole file. It is checked with its schema before it is written, and only onto the file as you opened it.",
    rawUnchecked: "No schema checks this file; YAML still has to parse.",
    rawNew: "This file isn't there yet: Write it creates it.",
    rawText: (path: string) => `The text of ${path}`,
    close: "Close",
    noForm: "No form for this yet: edit the file in the app, then propose it.",
    rawPickTitle: "Edit a file of the org pack",
    rawPick: "File",
    rawPickHint: "A path inside org-pack/, such as gates.yaml or patterns/S.GW.SOR.yaml.",
    // Patterns and wikis.
    patternTitle: "Add an integration pattern",
    code: "Code",
    codeHint: "Such as S.GW.NWP: a capital letter, then parts after dots.",
    patternName: "Name",
    definition: "What it is",
    interaction: "Interaction",
    route: "Route",
    targetType: "Target",
    controls: "Controls (comma-separated)",
    source: "Where it is written down",
    sourceHint: "A wiki page or a file, such as inputs/wiki/integration-patterns.md.",
    status: "Status",
    wikiTitle: "Add a wiki",
    wikiType: "Type",
    location: "Where it is",
    locationHint: "A folder of this metarepo, a Git repository's URL or a wiki's https:// address.",
    wikiPath: "Pages folder (git only)",
    wikiRef: "Branch or tag (git only)",
    // The AI page and Settings.
    aiAdapters: "Outside systems are set on Set up › Settings, and here:",
    settingsEdit: "Edit, then Propose: each change is a file you propose for review",
    runtimeOnAi: "The modes, assistants, models and AI decides are edited on Set up › AI.",
    openAi: "Open Set up › AI",
    addReposLink: "Add repos in the app (Set up › Repos)",
  },
  /**
   * ADR 0191: roles and the business analyst. A change goes product owner → architect → business
   * analyst → tech lead; each sees their own questions and what waits on them, in plain words.
   */
  roleWork: {
    asks: { business: "business", design: "design", delivery: "delivery" } as Record<
      string,
      string
    >,
    asksChip: (level: string) => `Asks about ${level}`,
    routeLabel: "Send it to",
    routePick: "Pick who answers it",
    route: "Send",
    routing: "Sending…",
    routed: (who: string) => `Sent to ${who}: it is on their Questions and Home now.`,
    routedFrom: (from: string, by: string, day: string) => `Moved from ${from} by ${by} on ${day}.`,
    noRole: "no role",
    // Owners: suggested from roles.yaml, accepted with one click.
    ownersTitle: "Who is on this change",
    ownersIntro:
      "Who answers each role's questions and reviews its hand-off. Saved in the change's file, it goes with the change's next hand-off.",
    nobody: "Nobody yet",
    editOwners: "Change who is on it",
    cancelOwners: "Cancel",
    saveOwners: "Save who is on it",
    suggestedTitle: "Suggested",
    suggestedFromTeam: (team: string, repos: string) => `from ${team}, which owns ${repos}`,
    suggestedDefault: "the organisation's usual person for this role",
    accept: "Accept",
    acceptFor: (who: string, role: string) => `Accept ${who} as ${role}`,
    accepted: (who: string, role: string) => `${who} is the ${role} on this change now.`,
    noSuggestion: "Nobody to suggest:",
    // At a glance: who the change waits on.
    waitsOn: (who: string, role: string) => `Waits on: ${who} (${role})`,
    waitsOnReview: "to review and approve its hand-off",
    waitsOnWork: "for this phase's work",
    waitsOnNobody: (role: string) =>
      `Waits on the ${role}, but nobody is named for it yet. Name them under Who is on this change.`,
    roleNames: {
      "product-owner": "product owner",
      architect: "architect",
      "business-analyst": "business analyst",
      "team-lead": "tech lead",
    } as Record<string, string>,
    // The work tracker: features, stories and tasks as work items.
    workItems: {
      title: "Work items in the tracker",
      intro:
        "Each story and its tasks go into your work tracker (Azure DevOps or another) as work items. Atticus keeps the id each one gets, so a later update changes it instead of making a second one.",
      none: "No work tracker is set up yet. Set one up on Set up › Adapters (manual works with no connection: each work item is a step for you).",
      manual:
        "Your work tracker is manual here: each work item is a step on Home › Manual steps with every field to copy (title, description, acceptance criteria, parent). Create it in the tracker, then record the id it got on the step.",
      live: "Atticus writes them to your work tracker on your click, and keeps each id.",
      push: "Put them in the work tracker",
      pushLive: "Put them in the work tracker (asks you to confirm)",
      update: "Update them in the work tracker",
      pushing: "Putting them in…",
      story: (title: string) => `Story: ${title}`,
      feature: (title: string) => `Feature: ${title}`,
      task: (title: string) => `Task: ${title}`,
      created: "in the tracker",
      waiting: "step waiting on you",
      toCreate: "not in the tracker yet",
      changed: "changed since: update it",
      gone: "no longer planned (left as it is)",
      openStep: "Open the step",
      empty:
        "The stories aren't written yet: they appear here once the stories stage has drafted them.",
      cantRead: (why: string) => `The work items couldn't be listed: ${why}`,
    },
    // The business analyst shapes the stories.
    shape: {
      title: "Shape the stories",
      intro:
        "Rename, split, merge or add a story in your own words. The AI then puts each task under the story it belongs to when the stories are drafted again, and the check makes sure no story is left without a task and no task without a story.",
      op: "What to do",
      ops: {
        rename: "Rename a story",
        split: "Split a story",
        merge: "Merge stories",
        add: "Add a story",
      } as Record<string, string>,
      story: "Story",
      stories: "Stories to merge (the first keeps its number)",
      name: "Its name",
      firstName: "The first part's name",
      words: "What it is for (optional)",
      part: "The other part's name",
      partWords: "What the other part is for (optional)",
      record: "Save",
      recording: "Saving…",
      recorded:
        "Saved. Draft the stories again on this tab and the AI maps the tasks to them; until then the stories are as they were.",
      waiting: "waits for the next draft",
      applied: "in the stories",
      remove: "Take back",
      removeFor: (what: string) => `Take back: ${what}`,
      entry: {
        rename: (story: string, name: string) => `Rename ${story} to "${name}"`,
        split: (story: string, names: string) => `Split ${story} into ${names}`,
        merge: (stories: string, name: string) => `Merge ${stories} into "${name}"`,
        add: (id: string, name: string) => `Add ${id}: "${name}"`,
      },
      uncovered: "Not covered yet",
      allCovered: "Every story has a task, and every task a story.",
      none: "Nothing shaped yet: the stories are one per flow the change changes.",
      notDrafted:
        "The stories aren't drafted yet: shape them once the stories stage has drafted them.",
      needStory: "Pick the story first.",
      needTwo: "Pick two or more stories to merge.",
      needPart: "Name the other part.",
    },
    /** ADR 0191: the critic's questions and old lenses, in plain words. */
    lens: {
      true: "Is it true?",
      complete: "Is it complete?",
      safe: "Is it safe?",
      ship: "Can it ship?",
      business: "Business",
      architecture: "Design",
      story: "Stories",
      ux: "Screens",
      delivery: "Delivery",
      "code-and-test": "Code and tests",
      release: "Release",
    } as Record<string, string>,
    // A suggested knowledge item, opened in place.
    passage: {
      open: "Read it here",
      from: (page: string, source: string) => `From ${page} (${source})`,
      quote: "The words it rests on",
      details: "Details",
      path: "Where the file is",
      none: "Its page couldn't be read just now; it is listed by name only.",
    },
    // Ask Atticus, answered from the organisation's knowledge too.
    ask: {
      knowledge: "From your organisation's knowledge",
      knowledgeIntro:
        "What your wikis and documents say, found by the question's words. Each is quoted with where it is from; Atticus doesn't word an answer of its own here.",
      items: "Knowledge items",
      passages: "Pages",
      none: "Nothing in your wikis or documents (inputs/) shares this question's words.",
      askAi: "To have your assistant word an answer from these, citing them:",
      catalogNone: "Nothing in the catalog answers it.",
    },
    // An owner question, sent through the notify adapter.
    send: {
      button: (owner: string) => `Send to ${owner}`,
      sending: "Sending…",
      sent: (owner: string) => `Sent to ${owner}. Record their answer here when it comes.`,
      step: "Notifications are manual here: sending it is a step for you on Home › Manual steps.",
      notSent: (why: string) => `Not sent: ${why}`,
    },
    // The brief as a form.
    brief: {
      title: "The brief",
      intro:
        "What the change is for, in your words. Each box is one part of the brief; the hint under it says what goes there.",
      edit: "Edit the brief",
      save: "Save the brief",
      saving: "Saving…",
      saved: "Saved the brief.",
      cancel: "Cancel",
      details: "Details",
      file: (path: string) => `Saved as ${path}`,
      changed: "Someone changed the brief since you opened it: open it again to see their words.",
      empty: "Not written yet.",
      write: "Write the brief",
    },
    // Home, by role.
    home: {
      yourChanges: "Your changes",
      yourChangesIntro: (role: string) =>
        `The changes you are on as ${role}, and what waits on you.`,
      waitsOnYou: "waits on you",
      waitsOnOther: (who: string) => `waits on ${who}`,
      noneYours: "No change in flight names you yet.",
      admin: "Setting up Atticus",
      adminIntro:
        "Setting up, upgrading and the catalog's checks. The people who look after Atticus here deal with these.",
      designWaits: (n: number) =>
        `${n} design finding${n === 1 ? " waits" : "s wait"} for the architect; ${n === 1 ? "it doesn't" : "they don't"} hold the brief.`,
    },
  },
  // The IDE shell's side panel (beta.26): the estate as a tree, each item opening its page.
  explorer: {
    title: "Estate",
    /** The side panel's name, for the shell's landmark around the Explorer. */
    label: "Explorer",
    filter: "Filter the explorer",
    filterPlaceholder: "Filter",
    sections: {
      changes: "Changes in flight",
      systems: "Systems",
      questions: "Questions",
      pinned: "Pinned",
    },
    empty: {
      changes: "No changes in flight",
      systems: "No systems read yet",
      questions: "No open questions",
      pinned: "Nothing pinned yet. Pin a page to keep it here.",
    },
    loading: (section: string) => `Loading ${section.toLowerCase()}…`,
    couldntLoad: (why: string) => `Couldn't load: ${why}`,
    retry: "Retry",
    /** The section's count, read after its name. */
    count: (n: number) => `${n}`,
    repos: (n: number) => `${n} repo${n === 1 ? "" : "s"}`,
    waitsOnYou: "waits on you",
    /** A row's whole name for a screen reader, its parts joined. */
    spoken: (...parts: string[]) => parts.join(", "),
    items: (n: number) => `${n} item${n === 1 ? "" : "s"}`,
    /** The kinds a box of the map is marked with. */
    kinds: { lib: "lib", gw: "gw", outside: "outside" },
    kindWords: { lib: "library", gw: "gateway", outside: "outside the estate" },
    ownerQuestions: "Owner questions",
    pin: "Pin",
    /** The Pin button's name; pressed, the page is pinned and a press unpins it. */
    pinHere: (page: string) => `Pin this page: ${page}`,
    unpinHint: "Delete unpins it",
    /** A pinned page's name: its section, its page and what it is about. */
    pageLabel: (...parts: string[]) => parts.join(" › "),
    stages: {
      draft: "draft",
      define: "define",
      design: "design",
      plan: "plan",
      build: "build",
      qa: "qa",
      "release-ready": "release",
      "post-release-review": "review",
      returned: "returned",
    } as Record<string, string>,
  },
} as const;
