---
name: architecture-plan
description: Use when designing system architecture, planning complex multi-file features, analyzing cross-module impact, or preparing an execution plan.
---

# Architecture & Technical Planning Playbook

Produce concrete, evidence-backed technical designs grounded in the repository's real source code before writing implementation code.

## 1. Discovery Phase (Read-Only Evidence First)

1. **Map the Current Architecture**:
   - Use `find` (semantic MCQ search) and `rg`/`ast-grep` (or spawn `scout`) to trace actual entrypoints, data models, state boundaries, and external integrations.
   - Never assume how a subsystem works from filenames alone—cite exact `file:start-end` anchors.
2. **Identify Constraints & Bottlenecks**:
   - Check performance constraints (latency budgets, batch sizes, CPU/GPU memory, DB indexes, lock contention), security boundaries, and backward compatibility requirements.

## 2. Plan Structure (Actionable & Minimal)

Every architecture or implementation plan MUST specify:
1. **Goal & Invariants**: What changes, what must NOT break, and measurable acceptance criteria.
2. **File-by-File Touch Map**: Exact files/symbols to create or modify (`[file.ts](path#L10-L30)`), with data flow and interface signatures.
3. **Failure Modes & Edge Cases**: How timeouts, partial failures, migrations, or rollbacks are handled.
4. **Verification Plan**: Exact test, benchmark, or smoke-test commands (`pytest`, `rg`, `tsc --noEmit`, health probes) required to prove completion.
