# @maycombhq/atticus

Atticus maps a multi-repo ecosystem from its code and runs every change from idea to release, with an AI critic and human approvals. This package is the `atticus` command line and its local app, in one self-contained package.

```bash
npm install -g @maycombhq/atticus@beta
atticus --version
atticus doctor
```

- Needs Node.js 22.13 or later and Git 2.30 or later.
- No install scripts: `--ignore-scripts` installs the same thing.
- Search by meaning comes with it: the local embedding model (`@maycombhq/embed-model`) and this machine's onnxruntime (`@maycombhq/onnxruntime-<platform>-<arch>`) are optional dependencies that carry their files, so nothing is downloaded after install. `--omit=optional` leaves them out; Atticus then searches by words and names.
- Everything Atticus needs is bundled inside; `THIRD-PARTY-LICENSES.txt` lists every third party bundled and its licence.

Plugin authors: the plugin SDK is `@maycombhq/sdk`.

The install guide, including an offline bundle for machines without a registry, is `docs/guide/install.md` in the Atticus repository. Licensed under Apache-2.0.
