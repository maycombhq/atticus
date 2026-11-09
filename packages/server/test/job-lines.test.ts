import { describe, expect, it } from "vitest";
import { JOB_LINES, JOBS_KEPT, JobManager, jobLine } from "../src/jobs.js";

/** ADR 0187: a job keeps what it prints, for the Console, and tells whoever listens. */

describe("a job's lines", () => {
  it("keeps what the work prints, from c.line or jobLine anywhere inside it, and tells listeners", async () => {
    const jobs = new JobManager(() => undefined);
    const heard: string[] = [];
    jobs.subscribe((c) => {
      if (c.type === "lines") heard.push(`${c.at}:${c.lines.join("|")}`);
      else heard.push(`state:${c.job.state}`);
    });
    const deep = async () => {
      await new Promise((r) => setTimeout(r, 5));
      jobLine("from deep inside");
    };
    const j = jobs.start(
      "scan",
      async (c) => {
        c.line("Scanning forge-ledger");
        await deep();
        c.line("two\nlines");
      },
      { title: "Scan", meta: { handoffRun: "run-1" } },
    );
    expect(j.title).toBe("Scan");
    await jobs.settle(j.id);
    expect(jobs.linesOf(j.id)).toEqual({
      from: 0,
      total: 4,
      lines: ["Scanning forge-ledger", "from deep inside", "two", "lines"],
    });
    expect(jobs.linesOf(j.id, 2)?.lines).toEqual(["two", "lines"]);
    expect(jobs.metaOf(j.id)).toEqual({ handoffRun: "run-1" });
    expect(heard[0]).toBe("state:running");
    expect(heard).toContain("1:from deep inside");
    expect(heard.at(-1)).toBe("state:done");
    // Outside a job, jobLine prints nowhere.
    jobLine("nowhere");
    expect(jobs.list().map((x) => x.id)).toEqual([j.id]);
  });

  it("gives a job that printed nothing its result's lines and errors when it ends", async () => {
    const jobs = new JobManager(() => undefined);
    const a = jobs.start("local", async () => ({ result: { lines: ["Applied 3 facts"] } }));
    const b = jobs.start("sync", async () => {
      throw new Error("git clone failed");
    });
    await jobs.settle(a.id);
    await jobs.settle(b.id);
    expect(jobs.linesOf(a.id)?.lines).toEqual(["Applied 3 facts"]);
    expect(jobs.linesOf(b.id)?.lines).toEqual(["git clone failed"]);
  });

  it("keeps a job's last lines only, and the last finished jobs only", async () => {
    const jobs = new JobManager(() => undefined);
    const j = jobs.start("scan", async (c) => {
      for (let i = 0; i < JOB_LINES + 5; i++) c.line(`l${i}`);
    });
    await jobs.settle(j.id);
    const l = jobs.linesOf(j.id)!;
    expect(l.total).toBe(JOB_LINES + 5);
    expect(l.from).toBe(5);
    expect(l.lines[0]).toBe("l5");
    for (let i = 0; i < JOBS_KEPT + 3; i++)
      await jobs.settle(jobs.start("index", async () => undefined).id);
    expect(jobs.list().length).toBeLessThanOrEqual(JOBS_KEPT + 1);
    expect(jobs.get(j.id)).toBeUndefined();
  });
});
