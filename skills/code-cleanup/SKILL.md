---
name: code-cleanup
description: Use when refactoring code, removing dead code, eliminating duplication, or improving maintainability without changing external behavior.
---

# Safe Refactoring & Code Cleanup Playbook

Improve code hygiene, eliminate duplication, and remove dead code while strictly preserving observable runtime behavior.

## 1. Golden Rules of Cleanup

1. **Lock Behavior Before Touching Code**:
   - Run the existing test suite or typechecker BEFORE editing to establish a green baseline.
2. **Verify Dead Code Before Deletion**:
   - Before removing any function, type, export, or config key, run `rg -n "symbol_name"` and `ast-grep` across the entire repository (including dynamic imports, templates, tests, and configs) to prove 0 references exist.
3. **Deduplicate with Restraint**:
   - Extract shared helpers only when `>= 3` call sites share identical domain logic, or `2` call sites must stay lockstep by specification. Prefer clear inline code over premature abstraction with boolean flag parameters.

## 2. Execution & Verification

- Read target line ranges (`enforceSeenLines: true`) before every `edit`.
- Apply structural changes incrementally and verify with `ast-grep` or compiler checks (`tsc --noEmit`, `ruff`, `cargo check`).
- Re-run the baseline test suite after cleanup. If any test changes status, revert or fix immediately.
- Never mix behavioral feature changes with structural cleanup in the same step unless explicitly requested.
