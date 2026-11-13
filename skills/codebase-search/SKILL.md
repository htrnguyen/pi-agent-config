---
name: codebase-search
description: Use when searching, exploring, or locating code, symbols, functions, architecture, or behaviors across a large repository. Combines semantic MCQ search (find), AST structural search (ast-grep), ripgrep (rg), and scout subagent delegation.
---

# Large Codebase Search & Discovery Playbook

Maximize speed and precision while keeping context consumption minimal when exploring large repositories.

## 1. Choose the Right Search Tool (3-Prong Cascade)

| Goal | Primary Tool | Command / Invocation | Why |
| :--- | :--- | :--- | :--- |
| **Find behavior / concept / flow** (when exact symbol name is unknown) | **`find` tool (`jfind`)** | `find` tool or `omp find "<behavior description>" <path>` | Runs 4-stage MCQ probability cascade via `@judge` (`deepseek-v4.1-flash:low`) to rank files and return exact `file:start-end` ranges. |
| **Find exact symbol / string / error message** | **`grep` tool / `rg`** | `grep` tool or `rg -n -m 15 "exact_symbol" path/` | Instant lexical match respecting `.gitignore`. Always cap matches (`-m 15`) on broad terms. |
| **Find syntax / AST pattern** (calls, classes, hooks, signatures) | **`ast-grep` (`sg`)** | `ast-grep -p 'function $NAME($$$)' -l ts path/` | Ignores comments/strings and matches exact syntax trees across TypeScript, Python, Rust, Go, C++. |
| **Locate files by name / extension** | **`glob` tool / `fd`** | `glob` tool or `fd -t f "pattern" path/` | Fast path discovery without dumping directory trees. |

## 2. Search Execution Protocol

1. **Parallel First Probe**:
   - Launch `find` (for behavioral intent) and `grep`/`glob` (for known anchors) **in parallel** in your first turn.
   - Do not guess file paths—verify existence with `glob`/`fd` first.
2. **Targeted Line-Range Reads Only**:
   - Once `find` or `grep` returns `file:start-end`, call `read` ONLY on that specific line window (`±30` lines for context).
   - **NEVER** read an entire file `> 120` lines unless every section is being modified.
3. **When to Delegate to `scout` (`@memory`)**:
   - If an investigation requires tracing across `> 5` files or unfamiliar subsystems, spawn the `scout` subagent (`thinkingLevel: low`, `gemini-3.5-flash-lite:low`) to return a compressed `summary` + `files` (`path:line`) map so the main session context stays clean.
4. **Zero-Result Fallback**:
   - If the first search returns 0 hits, immediately switch modality (e.g., from literal `grep` to semantic `find` or structural `ast-grep`) before concluding a feature does not exist.
