# Component types: what a kind of component is, in your words

Atticus knows thirteen kinds of component (service, single-page app, BFF, gateway, worker, batch job, …). Your organisation has kinds of its own, and its own words for the built-in ones. A component type ([ADR 0180](../adr/0180-component-types-the-organisation-owns.md)) is a file an architect owns:

```
org-pack/component-types/<id>/type.yaml
org-pack/component-types/<id>/notes.md
```

`type.yaml` says what the kind is (`name`, `description`), how a read recognises one (`signals`: a dependency, an annotation, a file, a path, a repo type, words), where one usually runs (`runsOn`), how the canvas draws it (`draws`: shape, colour, a badge of one to three characters), and what one must and must not do (`must`, `mustNot`, in your words). `notes.md` is the architect's full write-up: conventions, reference implementations, review questions. A file under a built-in's id (`gateway`) rewords that built-in; `off: true` takes it out of your set.

```
atticus types list                 # the set: built-ins with yours applied
atticus types add forge-experience-api --name "Experience API" --description "..." --badge xp --shape rounded
atticus types notes forge-experience-api
```

Review the files in a pull request like the rest of the org pack.

## What uses them

- **Reads.** `atticus map <repo>` hands the reader the set, as data. For each component it writes one `component` fact: the type, and the line that shows a signal, which `atticus verify` checks like any claim. A type your set doesn't have is flagged, naming the file to add.
- **The canvas.** Each component wears its type's badge in its colour; the tools panel lists the types the picture has, and clicking one shows only its components (`type:<id>` in the filter).
- **Drawing a change.** A new box can be of a type: it takes the type's run-on defaults, and the panel shows what the type must not do.
- **The architecture stage** is handed what every type must and must not do, with the notes file named, so a component it drafts is of a type and keeps to it.
