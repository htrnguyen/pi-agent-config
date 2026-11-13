---
name: file-structure-cleanup
description: Use when moving, renaming, splitting, or reorganizing files, directories, modules, and import paths across a repository.
---

# Safe File & Module Reorganization Playbook

Move, rename, or split files and directories without breaking build pipelines, runtime imports, or Git history.

## 1. Pre-Move Impact Audit

1. **Map All Inbound & Outbound References**:
   - Run `rg -n "old_filename_or_module_path"` across the entire repo (source files, tests, `tsconfig.json`, `pyproject.toml`, `Dockerfile`, CI scripts, and dynamic `import()`/`require()` calls).
2. **Preserve Git History**:
   - Prefer `git mv <src> <dest>` over deleting and recreating files when operating inside a tracked Git repository.

## 2. Execution & Import Graph Update

1. **Update Imports Atomically**:
   - Update all relative and alias imports (`@/...`, `~/...`, Python package paths) in a single coordinated pass.
   - Check barrel files (`index.ts`, `__init__.py`) and re-exports to ensure public module boundaries remain intact.
2. **Verify Zero Broken Paths**:
   - Re-run `rg -n "old_path"` to confirm 0 stale references remain.
   - Run the project build/typechecker (`tsc --noEmit`, `python -m py_compile`, `pytest`, `cargo check`) to verify all module resolutions succeed.
