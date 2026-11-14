---
name: codebase-search
description: Use when searching, exploring, or locating code, symbols, functions, architecture, or behaviors across a large repository. Combines semantic MCQ search (find), AST structural search (ast-grep), ripgrep (rg), and scout subagent delegation.
---

# Large Codebase Search & Discovery Playbook

Maximize speed and precision while keeping context consumption minimal when exploring large repositories.

## 1. Choose the Right Search Tool (3-Prong Cascade)

| Goal | Primary Tool | Command / Invocation | Why |
| :--- | :--- | :--- | :--- |
| **Find exact symbol / string / error message** | **`grep` tool / `rg`** | `grep` tool or `rg -n -m 15 "exact_symbol" path/` | Instant lexical match respecting `.gitignore`. Always cap matches (`-m 15`) on broad terms. |
| **Find syntax / AST pattern** (calls, classes, hooks, signatures) | **`ast-grep` (`sg`)** | `ast-grep -p 'function $NAME($$$)' -l ts path/` | Ignores comments/strings and matches exact syntax trees across TypeScript, Python, Rust, Go, C++. |
| **Locate files by name / extension** | **`find` tool / `fd`** | `find` tool or `fd -t f "pattern" path/` | Fast path discovery without dumping directory trees. |
| **Broad multi-file / architectural recon** | **`scout` subagent** | `subagent({ agent: "scout", task: "..." })` | Runs read-only `zai/glm-5.3-flash:low` to map entrypoints and `file:start-end` anchors without bloating main context. |

## 2. Search Execution Protocol

1. **Parallel First Probe**:
   - Launch `find` (for file paths) and `grep` (for known symbols/anchors) **in parallel** in your first turn.
   - Do not guess file paths—verify existence with `find`/`fd` first.
2. **Targeted Line-Range Reads Only**:
   - Once `grep` or `scout` returns `file:start-end`, call `read` ONLY on that specific line window (`±30` lines for context).
   - **NEVER** read an entire file `> 120` lines unless every section is being modified.
3. **When to Delegate to `scout`**:
   - If an investigation requires tracing across `> 5` files or unfamiliar subsystems, spawn the `scout` subagent (`zai/glm-5.3-flash:low`, read-only) to return a compressed summary + `path:line` map so the main session context stays clean.
4. **Zero-Result Fallback**:
   - If the first search returns 0 hits, immediately switch modality (e.g., from literal `grep` to semantic `find` or structural `ast-grep`) before concluding a feature does not exist.
