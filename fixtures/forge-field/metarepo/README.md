# forge

The Atticus metarepo for the github platform.

- `org-pack/`: how this organisation works (change types, gates, patterns, checklists, skills). Changed only through pull requests.
- `catalog/generated/`: the catalog Atticus writes on every scan, one YAML record per file. `catalog/curated/` holds people's decisions.
- `openspec/`: changes (`openspec/changes/<id>/`) and the living specs.
- `workspace/`, `.index/`, `.runs/`: local state, never committed.

Next: `atticus repos discover <folder of clones>` and `atticus workspace sync`, then read each repo: `/atticus-map <repo>` in your assistant (or `atticus map <repo>`), then `atticus verify <repo> --write`.
