# 0052. The offline install bundle, the SBOM and the licence check

- Status: accepted
- Date: 2026-10-19

## Context

Atticus is installed on machines that may not reach a package registry, by people who aren't developers, and reviewed by a security team that asks what is inside. Building the first bundle also found two faults the monorepo hid: the command line imported `yaml` without declaring it (another package's copy resolved it), and the shipped dialects' self-tests pointed at test fixtures that aren't shipped, so every shipped dialect was dropped from scans outside the repository.

## Decision

- **`pnpm bundle`** writes `dist/atticus-<version>-offline.zip` and its `.sha256`: the built command line and app with every production dependency (`pnpm deploy`, hoisted, so there are no symlinks and each package exists once), the Forge practice fixtures, `install.ps1` (Windows) and `install.sh` (macOS, Linux), `SHA256SUMS`, `sbom.cdx.json` (CycloneDX 1.5), `THIRD-PARTY-LICENSES.txt`, `LICENSE` and a README. Node.js is not inside: organisations install it from their own catalogue, and the install scripts and `atticus doctor` say which version.
- **The install scripts** need no network and no administrator rights. They check Node, check every file against `SHA256SUMS`, copy the version into the user's own programs folder (`%LOCALAPPDATA%\Programs\Atticus\<version>`, or `~/.local/share/atticus/<version>`), put an `atticus` command on the user's PATH and print the version. Versions sit side by side, so going back is running the older bundle's script.
- **`pnpm bundle:test <zip>`** installs a bundle into a throwaway home folder with the network pointed nowhere, then runs `--version`, a practice sandbox, `doctor`, a scan and the app's health call. CI runs it on Linux and Windows with the full matrix and keeps the zips.
- **`pnpm licences`** (part of `pnpm lint`): every third-party package shipped is under an allowed licence (MIT, MIT-0, ISC, Apache-2.0, BSD-2/3-Clause, 0BSD, BlueOak-1.0.0, CC0-1.0, Unlicense, Python-2.0; for an `OR` expression one side, for `AND` every part), and Atticus's own packages are Apache-2.0. Today: 72 packages, 63 MIT, 8 ISC, 1 BSD-3-Clause.
- **`scripts/check-deps.mjs`** (part of `pnpm lint`): every package imports only what its `package.json` declares (test files may also use the workspace's test tools; the app's bundled source may use its devDependencies).
- **Shipped dialects carry their self-test fixtures** in `packages/extractors/dialects/fixtures/`.

## Consequences

An install is: copy one zip, run one script, run `atticus doctor`. The security review gets the SBOM, the licences, the threat model and the checksums with the bundle. A dependency with a licence outside the list stops the build until someone decides.
