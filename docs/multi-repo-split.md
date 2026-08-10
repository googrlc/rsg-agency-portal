# Multi-repo environment: CRM / AMS write-back split

This document covers two things:

1. How to set up the multi-repo Cursor Cloud environment (portal + Hermes + intake gateway).
2. A ready-to-paste brief for the backend agent that does the Hermes-side work.

The portal (`rsg-agency-portal`) is the front door. `routing.js` is the authoritative
route contract — read it before changing any backend, because it decides which instance
each `/api/*` path is proxied to.

---

## 1. Setting up the multi-repo environment

**Repos in the group:** `googrlc/rsg-agency-portal` (this repo), `googrlc/rsg-hermes`,
`googrlc/rsg-cptintake`. (Add `rsg-carrierhub` / `rsg-commission-tracker` only if the
agent needs to touch them — not required for the write-routing / split work.)

### Step 1 — Grant the Cursor GitHub app access to all three repos
1. GitHub → **Settings → Applications → Cursor → Configure**.
2. Under repository access choose **All repositories**, or **Selected repositories** and
   add `rsg-hermes` and `rsg-cptintake` alongside `rsg-agency-portal`.
3. Confirm it has the **clone code / create branches** and **pull requests** permissions.

### Step 2 — Add the repos to the environment (this is what clones them in)
1. Open **Cloud Agents → Environments** and select this project's environment.
2. Use **Update with Agent** (or **New Setup Run**) and add `rsg-hermes` and
   `rsg-cptintake` to the repo group.
3. Cursor clones each repo and captures a new **Build**. The next agent run starts from
   that Build with all three repos present.

> Selecting the repos in the dashboard is what actually brings them into the workspace.
> The `.cursor/environment.json` `repositoryDependencies` list only scopes the GitHub
> token to those repos — it does not clone them on its own.

### Step 3 — Config in code (`.cursor/environment.json`)
This repo declares its dependencies in `.cursor/environment.json`:

```json
{
  "install": "npm install --no-audit --no-fund",
  "repositoryDependencies": [
    "github.com/googrlc/rsg-hermes",
    "github.com/googrlc/rsg-cptintake"
  ]
}
```

Committing this switches the project from snapshot-managed to repo-managed environment
config. The `install` line above is the portal's own (zero-dependency) refresh; when the
multi-repo Build is created via **Update with Agent**, extend it to install each repo's
dependencies as needed.

### Step 4 — Secrets (environment-scoped; shared across all repos)
Add in the **Secrets** panel, scoped to the environment:

- `NOWCERTS_API_KEY` — only the write-in / ops-core instance should receive it.
- `DATABASE_URL` (or the Hermes DB connection vars).
- `HERMES_API_TOKEN` — the portal↔Hermes bearer.
- Any `rsg-cptintake` gateway keys (e.g. `RSG_INTAKE_API_KEY`).

### Expectations
- Adding repos produces a **new Build** — the repos appear in the **next** session, not
  the current run.
- The agent opens **separate PRs per repo** it changes.
- Setup failures are almost always Step 1 (GitHub app access).

---

## 2. Brief for the backend (multi-repo) agent

Paste this into the agent once the environment has all three repos.

```
CONTEXT
You are in a multi-repo workspace: rsg-agency-portal (the portal / front door),
rsg-hermes (the backend monolith), and rsg-cptintake (the intake gateway that
owns the NowCerts round-trips: /api/nowcerts/*, /api/reference/*, /api/intakes,
/api/proposals). The portal is a dumb path-prefix proxy; do not add business
logic there. Read rsg-agency-portal/routing.js and server.js first to learn the
exact route contract you must satisfy.

LOCKED DECISIONS (do not relitigate)
- NowCerts is the system of record. CRM values are overrides that outrank the
  synced value only until NowCerts reports the same thing.
- Match key across intake -> CRM -> AMS is the NowCerts GUID.
- Intake MAY create a NowCerts insured when the client has no GUID yet; creating
  the insured is how a new client earns its GUID. Before creating, do a
  pre-create existence check (name + email/DOB) and adopt an existing GUID if one
  matches, to prevent duplicate insureds.
- There is exactly ONE NowCerts core: it owns the sync mirror coming in
  (sync-health) and the write queue going out (push-to-ams -> queue ->
  portal_write_log, replayable via failed-pushes/retry). CRM, renewals, and
  intake READ the mirror and ENQUEUE writes through this core; they do not each
  hold NowCerts credentials.

ROUTE CONTRACT (must match the portal, already implemented in rsg-agency-portal)
The portal routes by env var. Your Hermes instances must serve these paths:
- CRM instance (HERMES_CRM_URL): /api/clients, /api/policies, /api/quotes,
  /api/workspace-stats, /api/opportunities, /api/pipeline, /api/leads
  (incl. sub-paths like /api/clients/{guid}, /api/policies/{guid}/push-to-ams,
  /api/opportunities/{id}/stage).
- Operations / NowCerts core (base HERMES_API_URL): /api/hermes/sync-health,
  /api/ams/failed-pushes(+/retry), /api/queue/{id}/retry, /api/ask, and the
  push-to-ams write path + queue/log.
- Finance (HERMES_FINANCE_URL): /api/commissions, /api/commission-statements,
  /api/commission-rules.
- Renewals (HERMES_RENEWALS_URL), Cases (HERMES_CASES_URL), Intake split
  (HERMES_INTAKE_URL) as already in routing.js.

TASKS (in order; open a separate PR per repo)
1. rsg-hermes: role-gated startup. Add HERMES_ROLE (write_in | finance_readout,
   default write_in). Only mount the route modules for the active role. Refuse to
   start if a finance_readout instance has NOWCERTS_API_KEY set, or a write_in
   instance is missing it. Adapt to however Hermes actually registers routes.
2. Postgres grants: role hermes_write (full CRUD on mirror + write spine) and
   hermes_finance (SELECT only on the mirror tables it needs; explicit REVOKE on
   portal_write_log / the AMS write queue / failed_pushes). Prefer pointing
   finance at a read replica. Deliver as a migration/SQL file.
3. Per-instance /healthz: report { role, modules_loaded, nowcerts: bool (never
   the key), db_user, mirror_lag_seconds (write_in only) }. Keep the portal's
   /api/services browser-safe -- do NOT surface internal URLs/keys through it.
4. rsg-cptintake + rsg-hermes: intake write-routing spine. On approval, classify
   each extracted field by owner and write AMS-owned facts (insured, policy,
   endorsement) to NowCerts FIRST (via the gateway), CRM-owned facts (leads,
   pipeline, cases, notes) to the CRM. Implement create-or-update keyed on the
   NowCerts GUID with the pre-create existence check. Every AMS write must go
   through the existing contract: field allowlist, read-back by GUID before
   write, and a queue + portal_write_log row.
5. PDF-of-record: store the source intake PDF in the client's NextCloud folder
   and link it; surface a documents list on the Client 360 payload
   (/api/clients/{guid}); support manual upload landing in the same folder.
6. Picklist alignment: drive the CRM's lead statuses, quote/pipeline stages,
   renewal statuses, and endorsement (Policy Change Request) types from the
   NowCerts reference lists (via /api/reference/*), storing the NowCerts option
   IDs/GUIDs -- not free-form labels -- so pushes are accepted.

CONSTRAINTS
- Keep money/ledger endpoints returning 405 as they do today; do not add AMS
  writes for commission/ledger.
- Preserve the portal's browser-safe boundary (no internal URLs/tokens to the
  client).
- Test end-to-end against a NowCerts sandbox where possible; include evidence.

REFERENCE
- Portal routing (HERMES_CRM_URL group): rsg-agency-portal PR #28. Read
  routing.js for the authoritative prefix list.
```
