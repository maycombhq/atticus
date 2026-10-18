# Evidence and confidence

Every fact keeps its provenance. A record carries a list of evidence (at least one item for
every generated record) and a confidence that follows from that evidence.

## Evidence

Each piece of evidence says where the fact was seen:

- `source`: what kind of input it came from: `code`, `config`, `spec`, `gateway`,
  `event-config`, `infrastructure`, `pipeline`, `migration`, `diagram`, `document`, `export` or
  `manual`;
- `repo`, `path` and `line`: the file and line, when there is one;
- `commit` and `scannedAt`: which version of the file, and when it was read;
- `extractor` and `dialect`: the `name@version` of what read it;
- `side`: for an interaction, which end the evidence is from (`caller`, `callee`, `gateway`,
  `definition`, `document`);
- `by`: for manual evidence, who stated it.

When the same fact is seen in several places, the evidence lists are unioned. Evidence that names
neither a file nor a person can't be traced, and the conformance suite reports it.

## Confidence

- `verified`: read directly from code, configuration or a published specification. An
  interaction is verified only when both ends are seen.
- `inferred`: one end only, or a diagram, a document or a rule.
- `asserted`: stated or confirmed by a person, which needs manual evidence naming them.

Documents never make a fact asserted, and a document never overrides a fact verified from code.
When two records of the same identity merge, the stronger confidence wins.

## Conflicts

When sources disagree about a field (a diagram says one protocol, the code another), the record
keeps the value from the strongest evidence and lists the disagreement in its `conflicts`, so a
person can settle it with a curated decision rather than the disagreement being lost.
