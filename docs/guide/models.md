# Choosing models at an organisation on Copilot

Atticus runs five kinds of AI step, and each can run on a different model (ADR 0121, its addendum on per-step models). This guide is for whoever looks after the org pack at an organisation whose people use GitHub Copilot: which model to name for each kind, why, and how a person overrides it.

## The five kinds of step

| Kind      | What runs as it                                                                                                       | What it needs from a model                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| read      | `atticus map` reading a repo into facts (each batch, and the fix round for rejected facts), and `atticus scan verify` | Reading a lot of code exactly, and quoting the line it cites                               |
| draft     | The feature, architecture and stories drafts, small changes, change and spec drafts, scan surveys, tasks and tests    | Judgment over a whole change: the strongest model you have                                 |
| critic    | Each of the critic's lenses on a draft, and the hand-up lens                                                          | Checking a draft against rules; a capable model, ideally another family from the drafter's |
| knowledge | The knowledge scan and find, what a change needs from the organisation, and `atticus knowledge ask`                   | Matching pages and items to a change and quoting them; volume, not depth                   |
| quick     | Closed judgments (is this the same question?), the context engine's expansion and ordering, names and short texts     | Short, closed answers: the smallest model that follows the format                          |

Atticus decides each step's kind in its code, never from the prompt. `atticus doctor` lists the model each kind runs on here and where that choice came from.

## A sensible default

Name the models in `org-pack/runtime.yaml` (it needs `schemaVersion: 2`; `atticus upgrade` moves a version 1 file there and changes nothing else), and commit it in a pull request:

```yaml
schemaVersion: 2
models:
  allowed: []
  read: copilot/claude-opus-4.5
  draft: copilot/claude-opus-4.5
  critic: copilot/claude-sonnet-4.5
  knowledge: copilot/claude-haiku-4.5
  quick: copilot/claude-haiku-4.5
```

| Kind      | Default tier | Why                                                                                                                                      |
| --------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| read      | Strongest    | Every fact must cite its line; a weaker reader's facts are rejected by the verifier and read again, which costs more requests, not fewer |
| draft     | Strongest    | Few requests per change, and they decide everything after them                                                                           |
| critic    | Middle       | Several lenses per draft and a round per draft: the most requests of any kind in a change, so the tier matters most here                 |
| knowledge | Smallest     | Many pages per scan; every quote is checked against its page, so a slip is caught                                                        |
| quick     | Smallest     | Many small, closed answers; every one is checked by a rule or a fact before it counts                                                    |

`vendor/family` is any model VS Code offers (`copilot/…` for Copilot's). A bare family (`claude-haiku-4.5`) means Copilot's. Use the names your Copilot plan lists: they change as Copilot adds models.

### The cost reasoning

On Copilot Business and Enterprise, a request to a premium model counts as a multiple of a standard one, and the multiple grows with the model. Atticus makes many requests per change, but unevenly: a stage's draft is one or two requests, while its critic lenses, the judgments behind each question and the knowledge matching are many more. Putting the strongest model only where judgment decides the outcome (read and draft) and smaller ones where every answer is checked by rules anyway (knowledge, quick) keeps most requests on the cheaper multiples without lowering what reaches a person. This guide quotes no prices: they change, and your plan's own page says what each model counts as. In VS Code, **Atticus: Pick the model** shows the note VS Code gives for each model when it gives one.

### When the admin turns a model off

If your Copilot policy doesn't enable a model runtime.yaml names, VS Code doesn't offer it. The step then takes the next choice (`atticus.model`, the chat's model, Copilot's first), and says once which model it passed over and why. It never fails silently, and it never picks a model nobody chose. In model mode, a model `models.allowed` doesn't list is passed over the same way, for `adapters.model`'s.

## How a person overrides it

- **VS Code:** **Atticus: Pick the model** asks "for every step, or for one kind", then lists every model VS Code offers by vendor. It writes `atticus.models.read`, `.draft`, `.critic`, `.knowledge` or `.quick` (one kind) or `atticus.model` (every kind that names none). The order is: the person's setting for the kind, runtime.yaml's, `atticus.model`, the chat's model, Copilot's first. The Next view says "in VS Code: <model> for <kind> steps".
- **IntelliJ:** Settings → Tools → Atticus has a field per kind. Copilot in IntelliJ doesn't let a plugin choose its model, so the AI step's notice names the model the step expects (your field, else runtime.yaml's) for you to pick in Copilot's own model picker before you send the prompt.
- **Model mode and headless Claude Code:** the editors pass the person's fields as `ATTICUS_MODEL_READ`, `_DRAFT`, `_CRITIC`, `_KNOWLEDGE` and `_QUICK`; from a terminal, set them yourself. runtime.yaml's `models.<kind>` comes next, then `adapters.model`'s model. Here the values are your provider's model names (such as `claude-haiku-4-5`), each one `models.allowed` lists when it lists any.

## Seeing what ran

Every run record keeps its kind and the model that ran it: the app's **Model runs** page shows both, and `atticus runs` and `atticus runs show <run>` print them. A hand-off answered in VS Code records the model VS Code used; a hand-off answered elsewhere says "Not recorded".
