# Emulator Panel

## Workflow

- When a change is complete and verified, commit it and push to `origin/main` without waiting to be asked. This overrides the general "don't commit or push unless asked" preference for this repository.
- Before committing, run `npx tsc --noEmit -p .` and `npm run build`, and install the new build with `npx vsce package --no-dependencies --skip-license && code --install-extension emulator-panel-0.0.1.vsix --force`.
- Commit messages: a short imperative summary line, then a bullet list of what changed.
