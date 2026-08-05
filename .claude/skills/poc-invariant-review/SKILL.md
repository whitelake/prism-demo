---
name: poc-invariant-review
description: Reviews prism-demo changes for PoC data-integrity violations, including tool-context leakage, premature exposure of evaluation A, signals leakage, bypassing the unified LLM client, and model-controlled state transitions. Use when reviewing changes to context building, reports, model calls, assessment state, interview judgment, or related tests.
---

# PoC Invariant Review

Use this workflow when reviewing changes that may affect experimental validity.

## 1. Determine affected invariants

Classify the change against:

1. Tool-mode context isolation
2. Evaluation-A server-side locking
3. Internal signals isolation
4. Unified and fully logged model calls
5. Backend-controlled workflow transitions

If none apply, state that explicitly.

## 2. Read the authoritative requirements

Read only the relevant sections from:

- `docs/prd.md`
- `docs/architecture.md`
- `docs/api-spec.md`
- `.claude/rules/poc-invariants.md`

Do not infer missing business behavior.

## 3. Trace the complete data path

For each affected invariant, inspect:

1. Input source
2. Service or state-machine processing
3. Database write
4. DTO or serializer
5. API response
6. Frontend rendering
7. Test coverage

Do not stop after checking only the frontend or controller.

## 4. Check for violations

Consult `references/review-checklist.md`.

Report findings by severity:

- Critical: can invalidate PoC data
- High: can leak experiment logic or conclusions
- Medium: creates documentation or implementation inconsistency
- Low: maintainability concern without experiment impact

Each finding must include:

- File and location
- Violated requirement
- Failure scenario
- Recommended correction
- Missing or inadequate test

## 5. Validate

Run the repository-defined invariant tests and relevant unit or integration tests.

Do not invent command names. Read `package.json` first.

## 6. Produce the review result

Return:

1. Invariants affected
2. Findings
3. Tests executed
4. Residual risks
5. Documentation conflicts requiring user confirmation
