---
name: debugging
description: Use when diagnosing bugs, crashes, test failures, regressions, race conditions, or unexpected runtime behavior before proposing any fix.
---

# Evidence-First Systematic Debugging

**Iron Law:** Never apply a speculative fix before identifying and verifying the root cause in actual source code and runtime outputs.

## 1. Four-Step Diagnosis Pipeline

1. **Capture & Reproduce**:
   - Read the exact stack trace, error code, failing test output, or log line without truncation (do not suppress stderr).
   - Reproduce the failure deterministically with the narrowest test or CLI command (`pytest path/to/test.py -k test_name`, `node --test`, `cargo test`).
2. **Trace Symptom → Mechanism**:
   - Locate the crash/failure site via `grep` or `find`, then read the surrounding lines (`enforceSeenLines: true`).
   - Trace backward from the failing sink to the caller and input state. Check boundary conditions: `null`/`undefined`/`None`, async race conditions, stale caches, config/env mismatches, or type coercions.
3. **Formulate & Test Single Hypothesis**:
   - State the exact root cause (`File:Line` + why the state becomes invalid).
   - If the bug involves complex concurrency, state machines, or fails after 1 fix attempt, escalate to `@slow` (`openai-codex/gpt-6.1-sol:high`).
4. **Surgical Fix & Regression Gate**:
   - Patch ONLY the responsible layer. Do not bundle unrelated refactoring or formatting.
   - Re-run the exact reproduction command to prove `FAIL → PASS`, then run the nearest test suite (`rtk pytest`, `rtk npm test`) to confirm zero regressions.

## 2. Deep-Dive Reference Playbooks (in this folder)
- `root-cause-tracing.md` — Backward data/control flow tracing from symptom to origin.
- `defense-in-depth.md` — Validating invariants across entry, business, and storage layers.
- `condition-based-waiting.md` — Eliminating flaky `sleep()`/timer race conditions in async tests.
