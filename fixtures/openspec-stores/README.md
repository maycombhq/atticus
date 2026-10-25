# OpenSpec stores (beta) fixtures

Invented Forge data for ADR 0126: OpenSpec store folders Atticus reads, and code-repo
`openspec/config.yaml` files hand-down adds a reference to.

- `forge-payments-store/`: a store as OpenSpec 1.14.0 writes it (`.openspec-store/store.yaml`
  with `version: 1`, `id` and `remote`), one open change, one archived change, two specs.
- `future-store/`: a store whose `store.yaml` is a later, unknown version with an extra key:
  Atticus still reads its id and says the format is newer.
- `unmarked-store/`: an `openspec/` folder with no `store.yaml`: read, with a note.
- `forge-ledger/openspec/config.yaml`: a code repo's OpenSpec config with comments and other
  keys; `references/` holds the expected files after hand-down adds the metarepo.
