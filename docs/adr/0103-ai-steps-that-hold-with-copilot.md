# 0103. AI steps that hold up with Copilot: attempts carried across a hand-off, a repeated answer stops, and a quote's ending forgiven

- Status: accepted (pending review by the product owner)
- Date: 2026-10-23
- Builds on: ADR 0083 (knowledge sources scanned and queryable), 0074 (the AI reads; every fact cites its code), 0090 (the VS Code extension runs the steps with Copilot)

## Context

The first run of the knowledge scan through the VS Code extension with a real Copilot model (GPT-4o mini, the only model a Copilot Free account gives an extension) never finished:

- **Attempts restarted on every hand-off.** A step that checks its AI answer hands back what failed, for another attempt, up to `--attempts` (3 by default). Through a hand-off each attempt is a new run, resumed with `--resume`. The steps counted their attempts from 1 on every resume, so a step that never got a good answer handed it back for ever. The extension's limit of 8 rounds was the only thing that stopped it.
- **The model wrote the same answer every time.** Shown its failed answer and the reasons, it wrote that answer again, word for word. Each round asked the same thing and got the same thing.
- **Its quotes were the page's words with its own ending.** "The Ledger team owns the Ledger service." for "The Ledger team owns the Ledger service, which people call the books."; "Synchronous via the gateway to a vendor." for that table cell; 'Network firewall rule' in single quotes for the page's double ones. The quote check forgave only whitespace and curly quotes, so every item failed.

## Decision

1. **The attempt count carries across a hand-off.** A resumed run's context pack holds what was handed back to it (`attempt N` and `checks on attempt N`). `resumedAttempt(run)` in `@maycombhq/ai` reads the attempt from it, and every step that loops on its checks continues from there: the knowledge scan, ask and find, a change's needs, and the scan survey, verify, review and spec draft. A step through a hand-off now asks at most `--attempts` times, as it does with a model it calls itself.
2. **An answer word for word the last one stops the step.** The pack records each source's sha256, so a resumed answer that is the same as the attempt it was handed back from is known. It is checked once more and not handed back again; the knowledge scan says why ("the answer is word for word the one attempt N gave, so asking again won't change it").
3. **The quote check forgives the punctuation a quote ends with, and single quote marks for double.** Every word must still be on the page, in order, under the cited heading. A sentence cut short, or a table cell quoted as a sentence, matches. Nothing else is forgiven. A quote shorter than 12 characters is still too short to check.

4. **A change's needs take a cited file named with the change's folder in front.** Copilot wrote `add-transfer-limit/brief.md` for the change's `brief.md`; `openspec/changes/<id>/` and `<id>/` in front of one of the change's own files name that file, and the need records it as the change folder names it. A quote's ending punctuation is forgiven there too.

Not changed: the model the extension uses. With `atticus.model` empty it is the one picked in Copilot Chat, else the first Copilot model. A bank's Copilot Business plan offers more; the setting picks one.

## Consequences

- With a weak model a step ends in at most `--attempts` rounds, with what failed, instead of looping.
- More of a weak model's items pass, with the same provenance: the quote is still on the page, word for word.
- C5 (the runtime interface) is unchanged; `resumedAttempt` is a helper on top of it.
