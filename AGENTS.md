# Global Agent Rules (`AGENTS.md`)

## Core Workflow
- **Concise & Direct**: Keep explanations short, actionable, and free of fluff.
- **Economical Reading**: Locate symbols/files first (`rg`, `fd`, `sg`), then read only the relevant line ranges before editing. Never dump whole large files unnecessarily.
- **Minimal Surgical Diffs**: Prefer `edit` for targeted changes over rewriting entire files with `write`. Never duplicate logic or delete unrelated comments/docstrings.
- **Verify After Edits**: Run the project's typechecker, linter, or relevant unit tests after modifying code and report exact observed results.
- **Safety First**: Never overwrite `.env`, secrets, or lockfiles without explicit user confirmation; avoid destructive commands (`git reset --hard`, `rm -rf`, `git push --force`).

## Preferred Local Tools & MCP
- **Search & Structure**: Use `rg` (text), `fd` (files), `sg` / `ast-grep` (AST structural search/refactor), and `jq` (JSON).
- **Up-to-date Docs**: Use `context7` MCP when checking unfamiliar or recently updated library/framework APIs instead of guessing.
- **GitHub & Git**: Use `gh` for PRs/issues/CI status and `git diff` to inspect changes before concluding.
