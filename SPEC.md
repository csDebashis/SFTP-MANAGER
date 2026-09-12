# SFTP Management Portal specification

| Field | Value |
|---|---|
| Status | Implementation-ready modular specification |
| Version | 1.2 |
| Product scope | Single-organization production deployment |
| Frontend | Node.js 24, Next.js, React, TypeScript, Material UI |
| Backend | Python 3.12, FastAPI, Pydantic, SQLAlchemy, AsyncSSH, APScheduler |
| Persistence | Durable SQLite database |

This file is the specification index. Requirements are owned by domain so
multiple contributors can work without editing one monolithic document. Each
change must update the smallest applicable module and its acceptance coverage.

## Authoritative modules

| Module | Ownership |
|---|---|
| [Product and scope](spec/01-product-and-scope.md) | Purpose, goals, release scope, assumptions |
| [Identity and access](spec/02-identity-and-access.md) | Accounts, sessions, roles, groups, grants, profiles |
| [Application experience](spec/03-application-experience.md) | Shell, navigation, dashboard, shared UI behavior |
| [SFTP and files](spec/04-sftp-and-files.md) | Server enrollment, browsing, transfers, file mutations |
| [Tasks and scheduling](spec/05-tasks-and-scheduling.md) | Recurrence, generation, work-item states, file detection |
| [Audit](spec/06-audit.md) | Event coverage, visibility, privacy, exports |
| [Data, architecture, and API](spec/07-data-architecture-and-api.md) | Models, components, endpoints, errors, concurrency |
| [Security and accessibility](spec/08-security-and-accessibility.md) | Security controls, privacy, WCAG, visual behavior |
| [Operations and persistence](spec/09-operations-and-persistence.md) | Logging, health, deployment, SQLite, scaling |
| [Quality and acceptance](spec/10-quality-and-acceptance.md) | Tests, release gates, traceability |

## Change policy

- The explicit user-approved behavior and the relevant module form the product
  contract. Resolve contradictions in the module before implementation.
- Behavior changes require pytest and/or Vitest coverage in the same change.
- Version 1.2 is the SQLite schema baseline. A new deployment starts with an
  empty `db` directory and creates the complete schema directly from the
  SQLAlchemy metadata. Alembic and incremental database migrations are not part
  of this release. An existing database must carry the current baseline marker
  and match its table/column shape; incompatible data is rejected and may be
  discarded by stopping the stack and clearing the `db` directory.
- A failing test must be diagnosed and fixed. If it expresses valid behavior
  that conflicts with another valid interpretation and the specification does
  not decide the issue, ask the product owner to confirm the contract before
  changing the test or behavior.
- Optional enhancements must be proposed separately and require approval before
  implementation.

The previous single-file v1.1 document is retained as
[historical context](spec/archive-v1.1.md) and is not a change target.
