# Dialects

Every organisation has house conventions: its own annotations, base classes, configuration keys
and descriptor files. A dialect teaches the scanner those conventions as data, without code
([C2: Dialects](../contracts/c2-dialects.md)).

## Rules

A dialect is a list of rules. Each rule has one way to match, in the files it names:

- an annotation (on a class, method, field or parameter);
- a base class;
- a method call, optionally only on a receiver of a given type;
- a configuration key (with `*` for one segment);
- an XPath over XML or a JSONPath over JSON or YAML;
- a regular expression over the file's text.

What matched is turned into a catalog record by templates (`${attr.path}`,
`${member.name | slug}`, `${match.1}`), with the evidence's source and side. A rule can claim only
`verified` or `inferred`; `asserted` is reserved for people.

## Tests come with the dialect

Every dialect ships tests: input files (inline or a fixture folder next to the dialect) and the
records they must and must not produce. A dialect whose tests fail does not load, so a broken
dialect can't quietly change the catalog.

## Inheritance

A dialect can extend others; a rule with the same id overrides the inherited one. Dialects that
ship with the product cover common open frameworks; an organisation's own dialects live in its
org pack.

## Determinism

Dialects, like extractors, read files only: no network, no AI model, no clock. The same files
always give the same records.
