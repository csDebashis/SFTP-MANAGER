---
name: sftp-manager-feature-change
description: Implement or review any SFTP Manager feature, behavior change, defect fix, API change, UI change, migration, or test change while keeping the modular product specification and framework-native tests synchronized. Use whenever work changes observable application behavior.
---

# SFTP Manager feature-change workflow

Use this workflow for every behavior-changing task in this repository.

## 1. Establish the contract

1. Read `SPEC.md` and the domain modules relevant to the requested behavior.
2. Treat an explicit user request as the newest requirement. Identify conflicts
   with an existing module before editing code.
3. Update the relevant module in `spec/` in the same change. Add or revise
   acceptance criteria when externally visible behavior changes.
4. Do not edit `spec/archive-v1.1.md`; it is historical context only.

## 2. Reproduce and cover the behavior

1. Reproduce defects with the narrowest reliable test or documented browser
   flow before changing implementation when practical.
2. Add framework-native tests:
   - backend/domain/API behavior: pytest in `backend/tests/`;
   - frontend behavior: Vitest and Testing Library beside the page or component;
   - cross-service behavior: integration tests using the disposable SFTP fixture;
   - schema changes: migration coverage for a fresh and an upgraded database.
3. This repository is Python and TypeScript, not Java. Interpret requests for
   “JUnit tests” as automated unit/integration tests in pytest and Vitest. Use a
   JUnit XML reporter only when a CI consumer explicitly requires the artifact.
4. Include failure, permission, loading, retry, and accessibility cases when
   they are relevant to the changed workflow.

## 3. Implement and diagnose

1. Make the smallest cohesive implementation that satisfies the module and
   preserves user data, authorization boundaries, audit rules, and secrets.
2. Run focused tests while iterating. Diagnose failures instead of weakening
   assertions or hiding errors.
3. If a failing test is stale because an explicit user requirement already
   resolved the behavior, update the test and document the contract change.
4. If a test represents reasonable, valid behavior but conflicts with another
   reasonable interpretation and neither the user request nor specification
   decides between them, stop. Tell the user the current behavior, the tested
   behavior, and the impact of each choice, then ask which contract to keep.
5. Infrastructure-only failures do not create a product decision. Fix the
   environment or report the concrete blocker.

## 4. Verify the complete change

1. Run focused backend and frontend tests.
2. Run `./scripts/verify-build-deploy.sh --verify-only` before handoff when
   Docker is available. This executes all tests and builds both production
   images.
3. For UI changes, exercise the affected workflow in a browser at desktop and
   narrow widths. Confirm loading, success, error, keyboard, and refresh states.
4. For scheduler changes, test deterministic occurrence keys, timezone and DST
   boundaries, process restart behavior, missed occurrences, and idempotency.
5. Report commands run, results, and any unverified external dependency.

## 5. Manage improvements separately

Record optional UX or architecture improvements separately from the requested
fix. Explain the user benefit and risk, and obtain approval before implementing
an enhancement that changes scope or product behavior.

