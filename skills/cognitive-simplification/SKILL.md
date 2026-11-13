---
name: cognitive-simplification
description: Use when simplifying complex functions, flattening deep nesting, untangling convoluted conditionals, or improving code readability.
---

# Cognitive Simplification Playbook

Reduce cyclomatic and cognitive complexity so functions read top-to-bottom without mental backtracking.

## 1. Core Simplification Transformations

1. **Guard Clauses Over Deep Nesting**:
   - Replace nested `if/else` pyramids (`> 2` indent levels) with early returns (`return`, `continue`, `throw`) at the top of the function.
2. **Named Predicates & Intermediate Values**:
   - Extract compound boolean expressions (`a && (b || !c) && d`) into descriptive local constants (`const isEligibleForRetry = ...`).
3. **Table-Driven / Map Dispatch**:
   - Replace repetitive `switch` or `if/else if` chains that map keys to values or handlers with a `Readonly<Record<K, V>>` lookup table.
4. **Single Level of Abstraction per Function**:
   - Separate I/O orchestration (network, disk, DB) from pure data transformation and validation logic so core logic is trivial to read and test.

## 2. Invariants & Verification

- Preserve exact evaluation order and short-circuit side effects when refactoring conditionals.
- Preserve public function signatures, return types, and error messages.
- Run typechecks and unit tests immediately after simplifying to confirm 100% behavioral equivalence.
