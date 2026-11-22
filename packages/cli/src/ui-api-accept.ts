import { personOnlyWhy } from "@maycombhq/ai";
import { Api, assistantActor, type Finding } from "@maycombhq/core";
import type { ChangeContext } from "@maycombhq/changes";
import { assistantOf, readRound, roundsOf, stageGateOf } from "@maycombhq/naysayer";
import { acceptableStageRule, readAccepted, wayOnKind } from "@maycombhq/planner";

/**
 * ADR 0203 A, the app's half: a stage's own blocking findings (the built-in gate
 * `stage-<stage>`, written when a stage's run ends) as the stage's thread shows them. Each open
 * one says whether the person using the app may accept it and, if not, why, as a kind the app
 * words in its copy file; an accepted one says who, why and when, as the stages read it
 * (readAccepted: never an assistant's resolution). Accept itself is the command line's own
 * `atticus finding <change> <id> waive` (findingAction), in ui-api-thread.ts.
 */

type FindingView = Api.StageFindingViewT;

/** Who the app records as acting, and the environment it runs in. */
export interface AppPerson {
  user: string;
  env?: Record<string, string | undefined>;
}

/**
 * Why a person's act is refused here: the app runs inside a Copilot session Atticus started
 * (ATTICUS_ACP_SESSION), where the command line refuses every act a person's name is recorded
 * with (person-only.ts), in the command line's own words.
 */
export function sessionRefusal(env: Record<string, string | undefined>, change: string) {
  if (!env.ATTICUS_ACP_SESSION) return undefined;
  const why = personOnlyWhy(["finding", change, "stage-000000000000", "waive"]);
  return `This runs inside a Copilot session that Atticus started, so it is refused: ${why}. The person runs it, in the app or their own terminal.`;
}

/** The fix in words, without the command line's own way to accept it or why it can't be. */
export const stageFixWords = (text: string) =>
  text.replace(/ (?:Or accept it:|It can't be accepted:)[\s\S]*$/, "");

/** Whether the app's person may accept this open blocking stage finding, and if not, why. */
export function acceptOf(
  f: Finding,
  ctx: Pick<ChangeContext, "orgPack"> | undefined,
  who: AppPerson,
): FindingView["accept"] {
  const as = who.user;
  const no = (why: Api.StageAcceptRefusalT) => ({ can: false, why, as });
  // Rule 6 first: a constitution rule is never accepted, by anyone.
  if (f.layer === "constitution") return no("constitution");
  if (!f.waivable || !acceptableStageRule(f.rule))
    return no(wayOnKind(f.rule) ?? "next-stage-needs");
  if (who.env?.ATTICUS_ACP_SESSION) return no("assistant-session");
  if (ctx ? assistantOf(ctx, who.user) : assistantActor(who.user)) return no("assistant");
  return { can: true, as };
}

/**
 * The newest round of the stage's own gate, each finding as the thread shows it: its options
 * (a fix, a comment, Accept; never Not relevant, which the stage's next run would raise again),
 * whether it may be accepted, and its acceptance.
 */
export async function stageGateViews(
  root: string,
  change: string,
  stage: string,
  o: {
    rel: string;
    ctx: ChangeContext | undefined;
    who: AppPerson | undefined;
    comments: (file: string) => FindingView["comments"];
  },
): Promise<{ findings: FindingView[]; problems: { file: string; message: string }[] }> {
  const gate = stageGateOf(stage);
  const round = (await roundsOf(root, change, gate).catch(() => [] as number[])).at(-1);
  if (round === undefined) return { findings: [], problems: [] };
  const r = await readRound(root, change, gate, round);
  const accepted = o.ctx
    ? await readAccepted(root, change, o.ctx, [stage]).catch(() => undefined)
    : undefined;
  const byId = new Map([...(accepted?.values() ?? [])].map((a) => [a.finding, a]));
  const findings = r.findings.map((s): FindingView => {
    const f = s.finding;
    const open = f.state === "open";
    const issue = f.kind === "issue";
    const a = byId.get(f.id);
    const file = `${o.rel}/${s.path}`;
    return {
      finding: f,
      file,
      options: {
        fix: stageFixWords(f.fix.text),
        apply: open && issue,
        dismiss: false,
        waive: open && issue && f.severity === "blocking" && f.waivable,
      },
      comments: o.comments(file),
      ...(open && issue && f.severity === "blocking" && o.who
        ? { accept: acceptOf(f, o.ctx, o.who) }
        : {}),
      ...(a && !open ? { accepted: { by: a.by, why: a.why, at: a.at } } : {}),
    };
  });
  return {
    findings,
    problems: r.bad.map((b) => ({ file: `${o.rel}/${b.path}`, message: b.message })),
  };
}
