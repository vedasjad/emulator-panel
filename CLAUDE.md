# Emulator Panel

## Workflow

- When a change is complete and verified, commit it and push to `origin/main` without waiting to be asked. This overrides the general "don't commit or push unless asked" preference for this repository.
- Before committing, run `npx tsc --noEmit -p .` and `npm run build`, then package and install the new build with `npm run package && code --install-extension emulator-panel-darwin-arm64-<version>.vsix --force`.
- The extension is macOS only and is packaged per target (`darwin-arm64`, `darwin-x64`). Publishing to the Marketplace (`npm run publish`, publisher `vedasjad`) is done only when the user asks.
- Commit messages: a short imperative summary line, then a bullet list of what changed.
