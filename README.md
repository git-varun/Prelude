# OPD AI Snapshot Tool

Oncology outpatient (OPD) visit-prep tool: ingests uploaded documents (blood
reports, prescriptions, radiology), extracts structured facts via OCR + LLM,
and presents a reviewed, sourced snapshot to the treating oncologist. Bun
monorepo workspace: `apps/api` (backend), `apps/web` (frontend), `packages/shared`
(shared types).

## Setup

```bash
bun install
cp .env.example .env   # then fill in DATABASE_URL and your chosen OCR_PROVIDER/EXTRACTION_PROVIDER credentials
bun run apps/api/src/db/seed.ts   # seeds dev users; see docs/02-implementation-blueprint.md for schema setup
```

## Run

```bash
bun --hot apps/api/src/index.ts     # API (or: cd apps/api && bun run dev)
bun --hot apps/web/src/server.ts    # web (or: cd apps/web && bun run dev)
```

## Test

```bash
bun test
```

## Ingestion eval (compare OCR providers against synthetic samples)

```bash
bun run eval:generate-samples   # from repo root — .env loading is cwd-based
bun run eval:ingestion
```

## Documentation

Frozen specs (do not edit without a deliberate spec-change decision):

- [`docs/01-mvp-specification (1).md`](docs/01-mvp-specification%20%281%29.md) — the frozen MVP spec (personas, business rules, milestones M1–M8)
- [`docs/02-implementation-blueprint.md`](docs/02-implementation-blueprint.md) — repo scaffold, schema DDL, API stubs, per-milestone task checklist
- [`docs/03-implementation-invariants.md`](docs/03-implementation-invariants.md) — binding state-machine rules (coverage_status, verification_state transitions, snapshot contract)

Living trackers (update as work happens; not frozen):

- [`docs/m1-backlog.md`](docs/m1-backlog.md) / [`docs/m2-backlog.md`](docs/m2-backlog.md) — known issues, resolved items, and design decisions per milestone
- [`docs/third-party-services.md`](docs/third-party-services.md) — every external vendor in use, required env vars, free-tier/DPA status

This project was scaffolded using `bun init` in bun v1.3.13. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
