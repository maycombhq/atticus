# Publishing the extension

How the Atticus extension (`maycombhq.atticus`) gets to people: the public VS Code Marketplace, Open VSX, or a `.vsix` file an organisation hands out itself. A person publishes; nothing here runs on its own.

## Before every release

1. Build the app and the command line: `pnpm exec turbo run build --filter=@maycombhq/ui --filter=@maycombhq/cli`.
2. Run the checks: `pnpm check` (or at least `pnpm lint` and `pnpm --filter atticus test`).
3. Set the version in `packages/vscode/package.json` and add a section to `packages/vscode/CHANGELOG.md`.
   - **Stable:** plain `major.minor.patch`. The Marketplace refuses pre-release versions such as `1.0.0-rc.1`.
   - **Pre-release:** an odd minor (0.3.0, 0.5.0) published with `--pre-release`. Keep the even minors for stable.
4. Package and try the `.vsix`: `pnpm --filter atticus package`, then **Install from VSIX…** in VS Code.

   Packaging copies the app into `media/app` with `THIRD-PARTY-LICENSES.txt`. It fails if a package in the app has a licence the repo doesn't allow (`scripts/bundle/inventory.mjs`).

## The VS Code Marketplace (public)

Once, to set up:

1. Sign in at <https://marketplace.visualstudio.com/manage> with a Microsoft account and create a **publisher**. Its ID must be the `publisher` in `package.json` (`maycombhq`); if you choose another ID, change `package.json` to match.
2. Get a credential `vsce` can publish with: a Personal Access Token from Azure DevOps (<https://dev.azure.com>, any organisation; scope **Marketplace → Manage**, organisations **All accessible organisations**). Keep it out of the repo.
3. `npx @vscode/vsce login maycombhq` and paste the token.

Each release:

```text
pnpm --filter atticus run marketplace                # stable
pnpm --filter atticus run marketplace:pre-release    # pre-release (odd minor)
```

**From GitHub instead of your machine:** `.github/workflows/publish-vscode.yml` runs these same steps when a GitHub release is published (the same release that publishes the npm packages), or by hand, where it defaults to a dry run that only packages. It waits for a person to approve the `marketplace` environment, publishes an odd minor as a pre-release, and keeps the `.vsix` as the run's artifact. Put the token in the repository secret `VSCE_PAT` instead of using `vsce login`.

The listing shows the README, the CHANGELOG, `media/icon.png` and the gallery banner. It can take a few minutes to appear. A verified publisher badge needs a domain verified on the publisher page; that's optional.

## Open VSX (VSCodium, Gitpod and other editors)

Create a namespace `maycombhq` at <https://open-vsx.org>, sign the publisher agreement, make an access token, then `npx ovsx publish atticus-<version>.vsix -p <token>`.

## Inside an organisation that doesn't use the public Marketplace

- **The `.vsix` file:** put `atticus-<version>.vsix` in the organisation's artifact store. People install it with **Install from VSIX…** or `code --install-extension atticus-<version>.vsix`.
- **An allow-list:** organisations that limit extensions (VS Code's `extensions.allowed` policy) add `maycombhq.atticus` to it.
- **A private marketplace:** some organisations run one for VS Code. Publish the same `.vsix` there.

The extension needs the `atticus` command line on the machine (npm, or the offline bundle) and GitHub Copilot Chat. It sends nothing anywhere but Copilot's model, through VS Code. Its README says so under "What is sent where".
