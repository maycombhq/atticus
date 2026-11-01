# 0157. A second pass on the gaps, in a fresh session, and line ranges that overlap

- Status: accepted (pending review by the product owner)
- Date: 2026-11-01
- Builds on: ADR 0124 (facts the assistant writes) and its addenda A-read, A-ranges, A-budget and A-ledger, R1 (the lines a read may have skipped), P2 (the HTTP method on its line), ADR 0141 (what a read cost)

## Context

R1 gave `atticus verify` the lists of what a read left: the files no fact cites (`coverage.unknown`), the lines that write a path, URL or topic no fact cites (`skipped`), the reviewed globs whose files hold such lines (`reviewedHolds`), the operations a spec declares that no entry covers (`specOpsUncovered`), and the entries no flow follows (`entriesNoFlowFollows`). `/atticus-map` asks the reader to work through them in the same session. By then that session has read the repo, written its facts and looped on verify: on a big repo it is near its limit, and the second pass is the part that gets cut short or summarised.

A file bigger than one session is read in line ranges (A-ranges), every line once. A method, an OpenAPI operation or a configuration block that crosses a boundary is then half in one range and half in the next, and neither reader sees it whole.

P2 added a note when an entry or call claims an HTTP method its cited line, the next line and its `cite.with` lines don't write. It had never been measured on the fixture estates, so nobody knew whether it was ready to reject.

## Decision

### 1. `atticus map <repo> --gaps` (R2)

`--gaps` reads the last verify's `<repo>.verify.yaml` and plans a second pass for a fresh session (`planGaps`, packages/verify): each file no fact cites is read whole (in overlapping line ranges when it is bigger than a session), and every other line a list names is read with `GAP_CONTEXT_LINES` (20) round it, windows joined where they meet, each read with why it is there. The reads are packed in path order into sessions of `sessionTokensFor` the model's limit (A-budget), and the first session's are written as a prompt beside the facts, `<repo>.gaps.md`: what to read, why, where the facts and reviewed lines go, and to verify. Its facts go in the same facts file under the same id rules, as any part's do; nothing about the facts file changes.

- It refuses, with the command to run, when there is no verify yet, when the last verify was at another commit, or when the facts file or `<repo>.reviewed.jsonl` changed since: the lists are then not the gaps that are left.
- It writes only the prompt file and starts no session. When the gaps need more than one session, the prompt says so; verify after it, and `--gaps` again plans what is left from the new lists. A list verify counts past what it writes (`SKIPPED_LISTED`) is said, and the next plan holds it.
- `/atticus-map <repo> --gaps` (step 1) runs it and reads only the prompt's paths; step 10 tells the reader of the first pass, when the lists are long or the chat is near its limit, to run `--gaps` and have the person start a new chat. `FACT_RULES` is unchanged.

### 2. Line ranges overlap (R4)

Each range of a big file after the first starts `rangeOverlap(each)` lines before the last one ended: 20 lines, or 2% of the range when that is more, never more than a fifth of it (a file of few, long lines would otherwise pass the room). The range's tokens are its lines' share of the file, so the session budget counts the overlapped lines once more and nothing else. A range is done as before: a kept fact cites a line in it, or the reviewed file names it. A fact citing a line two ranges share accounts for both; both readers have read that line. The ranges are planned by one function (`lineRanges`), which `--gaps` uses too.

### 3. The method note, measured (P2)

See the measurement section below.

## Consequences

- A second pass gets a whole session for itself, and costs only the files and lines it reads.
- A plan with line ranges made before this is re-planned by the next `--estimate` (its ranges differ, so it is not the same plan). A range a kept fact cites a line of is still done; one only the reviewed file named under its old bounds is not, and is read (or reviewed) again under its new ones. Plans without line ranges are unchanged.
- No contract changes: the facts file, the reviewed file, the read plan and C1 to C6 are as they were.
