# eOffice API writer and per-project rules — Design Spec

Status: draft, awaiting review.
Date: 2026-10-12
Builds on: `2026-10-12-group-log-task-design.md` (group runs, `logDir`, per-child ledger).

## Problem

eOffice is written through Playwright UI automation (`scripts/eoffice-write.mjs`):
slow, brittle against layout changes, and two separate confirmation steps
(create task, report progress). The user now has an eOffice API access token.
Each project also has its own logging rules (task-name template, parent task,
owner, assignees) that today are re-entered by hand every run.

## Verified facts (read-only probes, 2026-10-12, production host)

- Auth: `access_token` query parameter on every call. Token never printed.
- The current token can call the **`work-normal-normal`** object:
  `GET /api/work/normal/gets` and `GET /api/work/normal/item?ID=<id>` succeed.
- The same token is rejected with `accesstoken not of object` for
  `/api/work/task/*`, `/api/work/project/*`, `/api/admin/user/*`,
  `/api/admin/department/*`. Tokens are scoped per object.
- `normal/item` returns display names, not IDs. Observed fields: `ID`, `code`,
  `title`, `status`, `project_id`/`project_title`/`project_code`, `parent_id`/
  `parent_title`/`parent_code`, `assign_ids`, `follower_ids`, `owner_ids`,
  `start_plan`, `end_plan`, `start`, `end`, `time_plan`, `time_real`,
  `priority`, `percent`, `progress_type`, `type_id`, `tasklist_id`,
  `workflow_type`, `department_created_id`, `is_sub`, `deep_level`.
- Real One Nova task (ID 2125808): Project `[NVG.ITD - ONENOVA] - CĐS TRIỂN KHAI DỰ ÁN ONE NOVA`
  (code 1456) → parent task `[NVG.ITD - CDS Tập Đoàn] - OneNova -P5- Development`
  (code 289654) → task titled
  `[NVG.ITD - CDS Tập Đoàn] - One Nova - BE - [BE] <summary>`; status
  `Đang đánh giá` (REVIEW), `percent` 100.
- The configured host is production (`eoffice.novagroup.vn`). The UAT docs live at
  `https://eoffice-uat.novagroup.vn/integration-document?menu=work&sm=work-normal-normal`.

## Unverified (must be proven on UAT before any production write)

1. Field names and write permission of `POST /api/work/normal/insert` and
   `/update` (expected to mirror the documented `work-task-task` fields:
   `title`, `project_id`, `parent_id`, `assign_ids`, `follower_ids`,
   `owner_ids`, `start_plan`, `end_plan`, `start`, `end`, `status`, `percent`).
2. That `status=REVIEW` with `percent=100` set on insert is enough, so the
   separate progress-report gate disappears.
3. `field_raws` returns raw IDs for people/project/parent; the `filters`
   parameter format of `gets`.
4. How to resolve people names to IDs given `admin/user/*` is not permitted
   for the current token (see Resolution).

## Goals

- Write tasks through the API from `/log-task`, keeping the draft → dry-run →
  explicit approval gates and the per-task ledger.
- Per-project `rules` that pre-fill name template, parent, owner, assignees,
  followers and completion values, so a run asks only for what changes.
- Credentials only from the environment: `EOFFICE_BASE_URL`,
  `EOFFICE_ACCESS_TOKEN`.

## Non-goals

- No change to `lark`, `manual`, or the evidence pipeline.
- No deletion of the Playwright writer; it stays as a fallback platform
  (`eoffice`) until the API path is proven.
- No automatic creation of parent tasks or projects.
- No batch endpoint (none documented): tasks are created one call at a time.
- No bypass of the approval gate, and no production write before the UAT checks.

## Config

New platform value `eoffice-api`. The group entry stays as in the group spec;
each child gains `rules`:

```json
"one-nova-be": {
  "params": { "project": "[NVG.ITD - ONENOVA] - CĐS TRIỂN KHAI DỰ ÁN ONE NOVA" },
  "rules": {
    "nameTemplate": "[NVG.ITD - CDS Tập Đoàn] - One Nova - {layer} - [{layer}] {summary}",
    "layer":     { "mode": "fixed", "value": "BE" },
    "parent":    { "mode": "ask", "search": "OneNova -P", "remember": true },
    "owner":     { "mode": "ask", "default": "Trần Nguyễn Đang Huy", "remember": true },
    "assignees": { "mode": "ask", "default": ["Trần Nguyễn Đang Huy"], "remember": true },
    "followers": { "mode": "fixed", "value": [] },
    "done":      { "percent": 100, "status": "REVIEW" }
  }
}
```

- `mode: fixed` — used as is, never prompted.
- `mode: ask` — prompted once per run; the pre-selected value is `default`, or
  the value remembered from the last run when `remember` is true.
- `search` (on `parent`) — candidates are fetched with `normal/gets`, filtered
  to the project and to titles containing the search text, newest first, capped
  at 5 choices.
- `{summary}`, `{layer}` are the only template variables. An unknown variable
  is a config error.
- Remembered values live in `<logDir>/state/<child>.json`; they are defaults
  offered for confirmation, never applied without the draft approval.
- Optional numeric ID overrides (`params.projectId`, per-name entries in a
  `people` map) skip lookup; see Resolution.

## Run flow

1. Resolve the project (group spec) and load its `rules`.
2. Gather evidence and candidate tasks (unchanged).
3. Ask the run settings once: parent, owner, assignees (defaults pre-selected).
4. Draft table per task: rendered name, parent, owner, assignees, dates,
   percent. The user may edit any task or override a field for one task.
5. Dry-run: resolve every name to an ID, print the exact payload (token
   redacted) and the target host. Stop on any unresolved or ambiguous name.
6. Explicit approval, which shows the host so production is never implicit.
7. Create tasks one by one with `insert`; ledger each task with the returned
   `ID` as `externalId` only after the response confirms it. A failure is
   reported by task name, never retried with altered data.
8. If UAT proves item 2 above, no second gate. Otherwise keep the existing
   second, separate gate for progress.

## Resolution of names to IDs

Preferred: `field_raws` on `normal/gets`/`item` to read raw IDs from existing
tasks (the user's own prior tasks give the owner, assignee, project and
parent IDs). Fallbacks in order: IDs given in config (`projectId`, `people`
map), then the user pastes an ID. Never guess; an ambiguous name stops the run.
If lookup needs `project/*` or `admin/user/*`, the token must be granted those
objects, or the config must supply IDs.

## Components

- `scripts/lib/eoffice-api.mjs` — client: base URL and token from env, one
  `call(path, params)` that never logs the token, and typed errors for
  `error: true` responses (`not object`, validation).
- `scripts/lib/eoffice-rules.mjs` — pure functions: validate `rules`, render
  `nameTemplate`, merge defaults, build the `insert` payload.
- `scripts/eoffice-api-write.mjs` — CLI: `create --dry-run|--apply <tasks.json>`,
  same JSON input shape as `eoffice-write.mjs` plus resolved IDs.
- `.env.example` — add `EOFFICE_BASE_URL` and `EOFFICE_ACCESS_TOKEN` (names only).
- `SKILL.md`, `references/eoffice-api.md`, `projects.json.example` — procedure,
  rules reference, example.

## Safety

- The token is read only from the environment, never written to a file, a
  ledger, a draft, or any output. Responses are scrubbed of the token.
- `.env` is never read by the agent; the user runs commands that load it.
- The apply step prints the host and requires the explicit approval from
  step 6 each time.
- Production writes are blocked until the UAT checklist is recorded as done.

## Error handling

- `accesstoken not of object` → report which object lacks permission; stop.
- Missing env var → exit 2 with the variable name.
- Unresolved/ambiguous person, project, or parent → stop before any write.
- Partial create failure → ledger only confirmed tasks; report the rest.

## Validation

- Unit tests with a mocked `fetch`: template rendering, rules validation,
  payload building, token never present in output, error mapping.
- UAT checklist (manual, recorded): insert one task with the intended
  payload; confirm `status`/`percent` behavior; confirm parent and people
  resolve; confirm the ledger gets the returned `ID`.
- Production: a single supervised task after the UAT checklist passes.

## Open items

- A UAT token with `work-normal-normal` write permission (current token is
  production).
- Whether `parent` changes per phase (P5, P6, …) is handled by `ask` +
  `search`; no change needed if it stays fixed.
