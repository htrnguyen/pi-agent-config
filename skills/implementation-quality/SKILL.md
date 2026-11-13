---
name: implementation-quality
description: Use when implementing new features, endpoints, components, CLI commands, or behavior changes to ensure zero edit rejections, strict type safety, and verified delivery.
---

# High-Precision Implementation Playbook

Deliver production-ready code on the first pass with zero hallucinated APIs, zero hashline rejections, and full verification.

## 1. Pre-Implementation Checklist

1. **Discover Existing Patterns First**:
   - Use `find` or `grep` to locate 1–2 existing modules in the repo that solve a similar problem. Match the repository's exact naming, error-handling, logging, and import conventions.
2. **Verify Contracts & Types**:
   - Read target interfaces, schemas, and function signatures before writing callers. Never invent flags, methods, or config keys without checking the source definition.
3. **Strict `enforceSeenLines` Compliance**:
   - You MUST `read` the target line range before calling `edit`.
   - If `edit` reports a hash mismatch (`#XXXX != #YYYY`), immediately `read` the fresh line range and re-apply—never retry blindly.

## 2. Implementation Standards

- **Minimal Blast Radius**: Modify existing modules rather than creating new files unless a new module is explicitly required. Preserve all unrelated comments, docstrings, and user modifications.
- **Edge-Case Hardening**: Handle empty inputs, timeouts, error propagation, and resource cleanup (file handles, DB connections, timers, locks) explicitly.
- **No Silent Fallbacks**: Fail fast with actionable error messages rather than swallowing exceptions or returning silent defaults that mask bugs.

## 3. Mandatory Verification & Review Gate

1. Run syntax/typecheck and targeted unit/integration tests (`tsc --noEmit`, `ruff check`, `pytest`, `node --test`).
2. Check `rtk git diff` and `rtk git status` to confirm no stray edits or untracked artifacts remain.
3. For complex multi-file features, invoke `@advisor` (`reviewer` subagent on `zai/glm-5.3:low`) before final sign-off.
