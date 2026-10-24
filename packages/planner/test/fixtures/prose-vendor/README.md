# A vendor named only in prose (ADR 0116 addendum)

The stage fixtures' `add-fraud-check` brief names the invented vendor Northwind Pay only in a
sentence ("each order is screened by Northwind Pay's fraud screen"), not in backticks. Here the
estate doesn't know it yet: the test leaves the `northwind-pay` System out of the catalog.

- `expansion.yaml`: the context expander's answer for that brief, as an assistant gives it:
  search terms in the estate's words, and the one proper name, said to be none of the estate's
  ids, with the brief's own words it took it from.
- `expected-gaps.yaml`: the gaps the feature stage raises with the expansion on (the default).
  With it off, nothing marks the name by its form, so there are none.

Everything here is invented.
