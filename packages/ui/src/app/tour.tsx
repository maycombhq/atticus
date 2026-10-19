import { useEffect, useState } from "react";
import { useMe } from "./me.js";
import { baseRole } from "./roles.js";

/**
 * First-run tour: three steps through a role's home and first task. It opens once per role and
 * person (remembered in this browser), can be skipped, and replays from Help.
 */

interface Step {
  title: string;
  body: string;
  /** A CSS selector for what the step points at. */
  target?: string;
}

const HOME: Step = {
  title: "Your home",
  body: "Home shows what waits on you, the approvals you hold and the changes in flight. Your sidebar lists the screens of your view; every other screen is under All screens, and Ctrl+K jumps anywhere.",
  target: "#view-picker",
};
const ASK: Step = {
  title: "Ask in plain words",
  body: "Type a question such as “who calls ledger-api?” in the box at the top. Atticus answers from the catalog and always shows the query it ran.",
  target: ".ask-form",
};

const link = (screen: string) => `.nav a[href="#/${screen}"]`;

export const TOURS: Record<string, Step[]> = {
  "product-owner": [
    HOME,
    {
      title: "Write the brief",
      body: "Feature brief is where you describe the problem, who it is for and how you'll know it worked. The business critic sits beside it with plain reasons and fixes.",
      target: link("brief"),
    },
    {
      title: "Hand it to architecture",
      body: "When nothing blocking is open, Raise hand-off sends it on. A person approves every hand-off; nothing moves on its own.",
    },
  ],
  "business-analyst": [
    HOME,
    {
      title: "Break it down",
      body: "Breakdown shows the stories, the story bar they must meet and what no story covers yet.",
      target: link("breakdown"),
    },
    {
      title: "Check the trace",
      body: "Test trace follows every requirement to a story, a test and code, and flags the gaps before QA.",
      target: link("trace"),
    },
  ],
  architect: [
    HOME,
    {
      title: "Review the design",
      body: "Architecture review puts the design next to the integration patterns and what the code really does. Code wins over a diagram; conflicts go to triage.",
      target: link("arch-review"),
    },
    {
      title: "Settle the diagrams",
      body: "Reconcile compares each drawn edge with the code, and Intake asks you to confirm names the diagram uses.",
      target: link("reconcile"),
    },
  ],
  "team-lead": [
    HOME,
    {
      title: "Order the work",
      body: "Breakdown and the Task board show the tasks by repo in cross-repo order.",
      target: link("tasks"),
    },
    {
      title: "Watch the dates",
      body: "Initiatives shows who owes what and a timeline against the target release.",
      target: link("initiatives"),
    },
  ],
  developer: [
    HOME,
    {
      title: "Run a task with AI",
      body: "On the Task board, Run with AI hands the task to your own assistant with the context it needs. You review the diff; Atticus never pushes to a protected branch.",
      target: link("tasks"),
    },
    ASK,
  ],
  qa: [
    HOME,
    {
      title: "Own the trace",
      body: "Test trace shows coverage, the gaps before sign-off and the test kinds this change needs.",
      target: link("trace"),
    },
    {
      title: "Check the release",
      body: "The Release plan shows the gates, the deploy order and the evidence pack.",
      target: link("release"),
    },
  ],
  "delivery-lead": [
    HOME,
    {
      title: "File what's needed",
      body: "The service desk queue holds the drafted requests with every field ready to copy. Atticus never files on its own: filing makes a step a person does.",
      target: link("service-desk"),
    },
    {
      title: "Plan the release",
      body: "The Release plan computes the deploy order, the forecast and the evidence pack, and asks for go / no-go.",
      target: link("release"),
    },
  ],
  "platform-lead": [
    HOME,
    {
      title: "Map the estate",
      body: "Scans syncs and scans the repos. Scans read files only: no network, no AI.",
      target: link("scans"),
    },
    {
      title: "Bring in what teams know",
      body: "Intake reads diagrams, specs and exports dropped into inputs/, and asks a person when something needs deciding.",
      target: link("intake"),
    },
  ],
  designer: [
    HOME,
    {
      title: "Bring in prototypes",
      body: "Prototypes and UX holds what Atticus reads from your designs and the requirements drafted from them.",
      target: link("ux"),
    },
    ASK,
  ],
  "process-owner": [
    HOME,
    {
      title: "Your process",
      body: "The Org pack holds your procedures and request templates; changes to them go in by PR.",
      target: link("orgpack"),
    },
    {
      title: "Steps waiting",
      body: "To-do lists the manual steps your process causes, with every field ready to copy.",
      target: link("todo"),
    },
  ],
  "data-architect": [
    HOME,
    {
      title: "Tables and who uses them",
      body: "Contracts lists the data stores from DDL and migrations; pick a table to see its readers, writers and evidence.",
      target: link("contracts"),
    },
    {
      title: "What a change reaches",
      body: "The Impact explorer follows a table or column to everything that depends on it.",
      target: link("impact"),
    },
  ],
  sre: [
    HOME,
    {
      title: "Incident mode",
      body: "In the Impact explorer, Incident mode shows a failing system's blast radius, the owners to call and recent nearby changes, from the last scan. Atticus never connects to live systems.",
      target: link("impact"),
    },
    {
      title: "Timeouts and alerts",
      body: "Governance compares callers' timeouts with what they call, and shows what has no alert.",
      target: link("governance"),
    },
  ],
  "security-reviewer": [
    HOME,
    {
      title: "Unauthenticated calls",
      body: "Governance lists calls with no authentication declared and sensitive data by classification.",
      target: link("governance"),
    },
    {
      title: "The security review draft",
      body: "Each change's Release plan carries a security review draft generated from the catalog and the change.",
      target: link("release"),
    },
  ],
};

const KEY = (role: string) => `atticus.tour.done.${role}`;
const seen = (role: string): boolean => {
  try {
    return localStorage.getItem(KEY(role)) === "1";
  } catch {
    return false;
  }
};
const remember = (role: string) => {
  try {
    localStorage.setItem(KEY(role), "1");
  } catch {
    // Storage blocked: the tour simply shows again next time.
  }
};

/** Ask the tour to open again (the Help menu does this). */
export const replayTour = () => dispatchEvent(new Event("atticus:tour"));

export function Tour() {
  const { me } = useMe();
  const role = baseRole(me?.view ?? null, me?.roles ?? []);
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);

  useEffect(() => {
    if (role && TOURS[role] && !seen(role)) {
      setI(0);
      setOpen(true);
    }
  }, [role]);
  useEffect(() => {
    const on = () => {
      setI(0);
      setOpen(true);
    };
    addEventListener("atticus:tour", on);
    return () => removeEventListener("atticus:tour", on);
  }, []);

  const steps = role ? TOURS[role] : undefined;
  const step = steps?.[i];
  useEffect(() => {
    if (!open || !step?.target) return;
    const el = document.querySelector(step.target);
    el?.classList.add("tour-target");
    return () => el?.classList.remove("tour-target");
  }, [open, step]);

  if (!open || !steps || !step || !role) return null;
  const close = () => {
    remember(role);
    setOpen(false);
  };
  return (
    <div role="dialog" aria-modal="false" aria-labelledby="tour-title" className="tour panel hero">
      <div className="hud" style={{ fontSize: 10 }}>
        Tour · {i + 1} of {steps.length}
      </div>
      <h2 id="tour-title" className="h" style={{ margin: "6px 0" }}>
        {step.title}
      </h2>
      <p style={{ margin: "0 0 12px", lineHeight: 1.55, fontSize: 13 }}>{step.body}</p>
      <div className="row between">
        <button type="button" className="btn" onClick={close}>
          Skip the tour
        </button>
        <div className="row" style={{ gap: 6 }}>
          {i > 0 && (
            <button type="button" className="btn" onClick={() => setI(i - 1)}>
              Back
            </button>
          )}
          {i < steps.length - 1 ? (
            <button type="button" className="btn primary" onClick={() => setI(i + 1)}>
              Next
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={close}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
