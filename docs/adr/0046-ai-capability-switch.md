# 0046. What AI may do here: on, text only, or off (C6 and C4, additive)

- Status: accepted
- Date: 2026-10-19

## Context

Some organisations turn their assistant off, limit it to chat, or turn off image reading (OCR and vision). Atticus's deterministic core (scans, the catalog, impact, Ask, guides, reconcile of draw.io, Visio, Lucid and Mermaid files, the critic's rule checks, trace, drift, gates, hand-offs and the release views) never needed AI. But there was no way to say so: a gate started in hand-off mode waited for AI lens answers nobody would give, AI buttons showed with no assistant behind them, and pictures sat as "needs reading" with no next step for a person.

## Decision

- **`runtime.yaml` gains `ai: on | text-only | off`** (default `on`).
  - `on`: as before.
  - `text-only`: no AI step is given a picture (context packs carry text only, as they already do); pictures in `inputs/` become triage items for a person.
  - `off`: no AI step starts. `createRuntime` refuses hand-off, model and headless modes with an `AiOffError` that says what to do instead; recorded replay and the mock still run, for tests.
- **The critic with AI off** runs its rule checks alone and records each AI lens as skipped, "AI is off here". Skipped lenses never hold a gate (only waiting ones do), so every gate works without AI.
- **Intake** adds a triage kind, `needs-reading`, when AI is limited: pictures when image reading is off, free text too when AI is off. Each item says how to bring the facts in (redraw in draw.io with the catalog shape library, which Atticus reads exactly, or record owner answers and curated decisions). Its one option, "Nothing more to take from it", records a curated decision that clears it.
- **Local API**: `GET /api/me` carries `ai`. A new `POST /api/changes/{changeId}/critic` (`gate` optional; a change in a state with no gate is checked at the gate it goes to) runs the critic from the app: rule checks, and AI lenses handed to the assistant unless AI is off.
- **The app** shows an "AI OFF" or "TEXT-ONLY AI" chip in the top bar and the mode on Settings. With AI off, "Run the critic" becomes "Run the rule checks", and "Run with AI" and "Write stories with AI" give way to "write it yourself".

## Consequences

An organisation can install Atticus before it knows what its assistant allows, and change one line later. With Copilot limited to plain chat, hand-off still works: the prompt and context are files a person pastes and saves back.
