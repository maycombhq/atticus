# Code search fixtures (ADR 0118)

`repos/forge-vault` is an invented Forge service built on an in-house framework: its base path is set by the `@ForgeServiceBase` annotation on the application class (line 7), which no config file names, and one route is declared by the in-house `@VaultRoute` annotation. The tests copy it and add files its `.gitignore` files ignore (`generated/`, `*.log` except `keep.log`, `tools/scratch.ts`), so the grep, files and outline tools can be shown to skip them.
