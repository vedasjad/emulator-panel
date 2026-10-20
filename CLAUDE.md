# Emulator Panel

## Workflow

- When a change is complete and verified, commit it and push to `origin/main` without waiting to be asked. This overrides the general "don't commit or push unless asked" preference for this repository.
- Before committing, run `npx tsc --noEmit -p .` and `npm run build`, then package and install the new build with `npm run package && code --install-extension emulator-panel-darwin-arm64-<version>.vsix --force`.
- The extension is macOS only and is packaged per target (`darwin-arm64`, `darwin-x64`). Releases need a version bump, since a published version can't be uploaded again.
- Visual Studio Marketplace (publisher `vedasjad`): there is no access token (an Azure DevOps organization now needs an Azure subscription), so the user uploads both `.vsix` files by hand at marketplace.visualstudio.com/manage. Don't drive that page from the browser.
- Open VSX (namespace `vedasjad`, for Cursor, Windsurf and VSCodium): publish from here with `npm run publish:ovsx` after `npm run package`. The token is stored in the keychain by `npx ovsx login vedasjad`.
- Commit messages: a short imperative summary line, then a bullet list of what changed.
