# eOffice API writer and per-project rules — Design Spec

Status: revised draft (advisor pass and full API docs applied), awaiting review.
Date: 2026-10-12
Branch: `feat/eoffice-api-writer` (cut from `feat/group-log-task`, which it builds on).
Builds on: `2026-10-12-group-log-task-design.md` (group runs, `logDir`, per-child ledger).

## Problem

eOffice is written through Playwright UI automation (`scripts/eoffice-write.mjs`):
slow, brittle against layout changes, and two separate confirmation steps
(create task, report progress). The user now has an eOffice API access token.
Each project also has its own logging rules (task-name template, parent task,
owner, assignees) that today are re-entered by hand every run.

## Verified facts (read-only probes, 2026-10-12, production host)

- Auth: `access_token` query parameter on every call. The token is never printed.
- The current token can call the **`work-normal-normal`** object:
  `GET /api/work/normal/gets` and `GET /api/work/normal/item?ID=<id>` succeed.
- The same token is rejected with `accesstoken not of object` for
  `/api/work/task/*`, `/api/work/project/*`, `/api/admin/user/*`,
  `/api/admin/department/*`. Tokens are scoped per object.
- By default responses carry **display names**. With `field_raws=allfield`
  they carry **raw values**.
- **Codes are not IDs.** For task 2125808: `ID=2125808` but `code="2871269"`;
  `project_id=3869` but `project_code="1456"`; `parent_id=2089469` but
  `parent_code="289654"`. Never use any `*_code` value where an ID is expected.
- Raw values seen: `owner_ids="8990"`, `assign_ids="112,8990"` (comma-joined
  user IDs), `status="REVIEW"`, `priority=17` (Bình thường),
  `percent=100`, `workflow_type="MANUAL"`, `type_id=null`, `tasklist_id=null`,
  dates as `"2026-10-06 00:00:00"` (display form is `DD/MM/YYYY`),
  `time_plan` and `time_real` raw `null` (the displayed `4.00000` / `1d` are
  computed).
- One Nova shape: Project `[NVG.ITD - ONENOVA] - CĐS TRIỂN KHAI DỰ ÁN ONE NOVA`
  → parent task `[NVG.ITD - CDS Tập Đoàn] - OneNova -P5- Development` → task
  titled `[NVG.ITD - CDS Tập Đoàn] - One Nova - BE - [BE] <summary>`.
- **Docs for `work-normal-normal` (pasted by the user, `update` section truncated):**
  - `item` takes lowercase `id` (integer, required); confirmed working.
  - `insert` requires `title` and seven flags that have documented defaults:
    `assign_other_off=0`, `is_restrict_subtask_time=no`, `follower_not_view=0`,
    `assign_parent_off=0`, `follower_other_not_view=0`,
    `status_after_report=REVIEW`, `is_view_parent_task=0`. These are write-only:
    `item` does not return them.
  - `insert` and `update` have **no `percent` field** (full `update` section
    read). `percent` appears only in `gets` (as a filter and as output).
    `update` mirrors `insert` (same fields, none of the seven flags required)
    but its table shows no `id` row.
  - People fields (`assign_ids`, `follower_ids`, `owner_ids`, `created_by_id`)
    accept "a code or a name", e.g. `NV06,NV08,Nguyễn Văn C`. Names are valid.
  - Dates are `dd/mm/YYYY`; times are `hh:mm`.
  - `project_id` is documented as "Nhập: Mã dự án" (project code); `parent_id`
    is an integer; `department_created_id` is a path joined with `||`.
  - `status`, `priority`, `type_id`, `tasklist_id`, `progress_type` accept the
    Value column, or the ID column when `field_raws` is set. Values seen:
    `status` ∈ {PENDING (default), DOING, REVIEW, COMPLETED, NOT_COMPLETED, FAIL,
    PAUSE, CANCEL, EXPECTED, CLOSED}; `priority` ∈ {1 Cao, 14 Trung bình,
    17 Bình thường, 16 Thấp}; `progress_type` ∈ {PERCENT, NUMBER, TASKLIST,
    PROPORTION, TIMEFINISH}.
- **`gets` filters (verified read-only, with `field_raws=allfield`):**
  `filters=[{...}]` is a JSON array of objects. `{"s":"<keyword>"}` is a
  substring search on the title; `{"parent_id":"2089469"}` returned the 73
  children of that parent; `{"s":"…","parent_id":"2089469"}` narrowed to exactly
  the one matching task; `{"project_id":"3869"}` matched 1001 tasks while
  `{"project_id":"1456"}` (the project **code**) matched 0. So `gets` filters
  take the raw project ID.
- Children of the One Nova parent (ID 2089469) all sit at `REVIEW`/100% and use
  varying title forms, e.g. `[NVG.ITD - CDS Tập Đoàn] - OneNova - Mobile - Tích hợp api …`,
  `… - OneNova -Meeting - …`, `… - One Nova - BE - [BE] …`. The template and the
  layer value therefore differ per task kind, not only per project.
- The configured host is production (`eoffice.novagroup.vn`). The UAT docs live at
  `https://eoffice-uat.novagroup.vn/integration-document?menu=work&sm=work-normal-normal`
  and require a logged-in session (an unauthenticated request returns the
  login page).

## Unverified (must be proven on UAT before any production write)

1. **Write permission** of the token on `POST /api/work/normal/insert` and
   `/update` (the field list is now known from the docs; permission is not).
2. **How to reach 100% and `REVIEW`.** Neither `insert` nor `update` has a
   `percent` field (confirmed from the full docs). `percent` is only reported by
   the progress report (`progress_type=PERCENT`, "user updates the %"), which has
   no documented endpoint. Candidates to test on UAT, in order: (a) `status=REVIEW`
   at insert and check whether `percent` becomes 100; (b) `status=COMPLETED`;
   (c) `progress_type=TIMEFINISH` (automatic by completion time). If none yields
   `percent=100`, the hybrid plan applies: create through the API, then report
   progress through the existing UI writer (`report-progress`), keeping its
   separate approval gate.
3. **`project_id` on insert:** project code (as documented, e.g. 1456) or raw ID
   (3869)? `gets` filters take the raw ID, so test both on UAT.
4. Whether the seven required flags may simply use the documented defaults.
5. **How `update` identifies the task.** The `update` field table has no `id`
   row in the pasted docs (`item` requires `id`); test whether `update` takes `id`.

## Goals

- Write tasks through the API from `/log-task`, keeping the draft → dry-run →
  explicit approval gates and the per-task ledger.
- Per-project `rules` that pre-fill name template, parent, owner, assignees,
  followers and completion values, so a run asks only for what changes.
- Credentials only from the environment: `EOFFICE_BASE_URL`,
  `EOFFICE_ACCESS_TOKEN`.

## Non-goals

- No change to `lark`, `manual`, or the evidence pipeline.
- The Playwright writer stays as the fallback platform (`eoffice`) until the
  API path is proven on UAT.
- No automatic creation of parent tasks or projects.
- No batch endpoint (none documented): tasks are created one call at a time.
- No bypass of the approval gate, and no production write before the UAT checklist.

## Config

New platform value `eoffice-api`. The group entry stays as in the group spec;
each child gains `rules`:

```json
"one-nova-be": {
  "params": { "project": "[NVG.ITD - ONENOVA] - CĐS TRIỂN KHAI DỰ ÁN ONE NOVA" },
  "rules": {
    "nameTemplate": "[NVG.ITD - CDS Tập Đoàn] - One Nova - {layer} - {summary}",
    "layer":     { "mode": "fixed", "value": "BE" },
    "parent":    { "mode": "ask", "remember": true, "candidates": [
                    { "id": 2089469, "label": "OneNova -P5- Development" },
                    { "id": 2087612, "label": "05. One Nova - Phase 5 CDS thư ký - Điểm danh cuộc họp" } ] },
    "owner":     { "mode": "ask", "default": "<your full name>", "remember": true },
    "assignees": { "mode": "ask", "default": ["<your full name>", "<colleague full name>"], "remember": true },
    "followers": { "mode": "fixed", "value": [] },
    "dates":     { "actualFromPlan": true },
    "done":      { "status": "REVIEW" }
  }
}
```

- `mode: fixed` — used as is, never prompted.
- `mode: ask` — prompted once per run; the pre-selected value is `default`, or
  the value remembered from the last run when `remember` is true.
- `search` (on `parent`) — candidates come from `normal/gets`, filtered to the
  project and to titles containing the search text, newest first, capped at 5.
- `candidates` (on `parent`) — array of `{ id, label }`, at least one. Preferred
  over `search` (the API `s` filter is fuzzy). The first id is pre-selected when
  nothing is remembered and there is no `default`. Valid only on `parent`.
- `dates.actualFromPlan: true` — a task with `startPlan`/`endPlan` but no
  `start`/`end` gets its actual dates from the plan dates; an explicit
  `start`/`end` wins. Without the flag nothing is added.
- `layer` varies per task (BE, Mobile, Web, Meeting) through the task's own
  `layer`; `nameTemplate` has no `[{layer}]` suffix by default.
- `{summary}` and `{layer}` are the only template variables. An unknown
  variable is a config error.
- Remembered values live in `<logDir>/state/<child>.json`; they are defaults
  offered for confirmation, never applied without draft approval.
- Optional ID overrides: `params.projectId` and a `people` map of name → user
  ID let a run skip lookup when IDs are required (see Resolution).

## Draft → API field mapping

| Draft field (existing format) | API field | Note |
|---|---|---|
| Task Name | `title` = `nameTemplate` rendered with `{summary}` | the draft holds `{summary}` and the rendered title |
| Estimate (inferred range) | `start_plan`, `end_plan` | |
| Actual evidence (date range) | `start`, `end` | |
| Suggested log window | not sent | only picks the working day shown in the draft |
| Status (`Done` only) | `status` from `rules.done.status` | non-`Done` tasks are never created; `percent` has no insert field (see Unverified 2) |
| rules: parent | `parent_id` (integer ID) | chosen from the `gets` parent search |
| rules: owner / assignees / followers | `owner_ids`, `assign_ids`, `follower_ids` | full names, comma-joined, per the docs |
| params.project | `project_id` | code or raw ID, decided by UAT (Unverified 3) |
| fixed defaults | `assign_other_off`, `is_restrict_subtask_time`, `follower_not_view`, `assign_parent_off`, `follower_other_not_view`, `status_after_report`, `is_view_parent_task`, `progress_type`, `method` | the documented defaults, overridable in `rules` |

`time_plan` and `time_real` are not sent: their raw values are `null` and the
displayed values are computed. Revisit only if UAT shows they are required.

## Run flow

1. Resolve the project (group spec) and load its `rules`.
2. Gather evidence and candidate tasks (unchanged).
3. Ask the run settings once: parent, owner, assignees (defaults pre-selected).
4. Draft table per task: rendered name, parent, owner, assignees, dates,
   percent. The user may edit any task or override a field for one task.
5. Duplicate guard (read-only): for each task, `normal/gets` with
   `filters=[{"s":"<rendered title>","parent_id":"<parent ID>"}]` (verified to
   return exactly the matching task). A hit means the task already
   exists (logged by hand, via the UI, or by an earlier run whose response was
   lost): mark it "already exists", skip it, and ledger it with the existing `ID`.
6. Dry-run: resolve names to the forms insert needs, print the exact payload
   (token redacted) and the target host. Stop on any unresolved or ambiguous name.
7. Explicit approval, showing the host so production is never implicit.
8. Create tasks one by one with `insert`; ledger each task with the returned
   `ID` as `externalId` only after the response confirms it. A failure is
   reported by task name, never retried with altered data.
9. If UAT proves a status-only route reaches `percent=100`/`REVIEW`
   (Unverified 2), there is no second gate. Otherwise keep a separate second
   gate: the UI writer reports progress on the tasks just created.

## Fingerprint

The ledger fingerprint is over `<child path>|<normalized {summary}>|<sorted
evidence commits>`, not the rendered title, so editing `nameTemplate` never
breaks deduplication.

## Resolution of names to IDs

- **People** need no lookup: the docs accept full names (or staff codes) in
  `assign_ids`, `follower_ids` and `owner_ids`. The writer sends names exactly
  as configured and relies on the API to reject an unknown one.
- **Parent** is a task ID: the `gets` parent search (project filter by raw ID
  plus `s` text) returns candidates with their raw `ID`; the user picks one.
- **Project** needs one ID or code known in advance: read it once from an
  existing task of the project (`field_raws=allfield` gives `project_id` and
  `project_code`) and store it as `params.projectId` / `params.projectCode`.
  Which of the two `insert` takes is decided by UAT (Unverified 3).

Never guess; an ambiguous or missing parent stops the run. Lookup through
`project/*` or `admin/user/*` is not available to the current token and is
not needed.

## Components

- `scripts/lib/eoffice-api.mjs` — client: base URL and token from env, one
  `call(path, params)` that never logs the token, typed errors for
  `error: true` responses (`not object`, validation).
- `scripts/lib/eoffice-rules.mjs` — pure functions: validate `rules`, render
  `nameTemplate`, merge defaults, build the `insert` payload.
- `scripts/eoffice-api-write.mjs` — CLI: `check-duplicates`, then
  `create --dry-run|--apply <tasks.json>`.
- `.env.example` — add `EOFFICE_BASE_URL` and `EOFFICE_ACCESS_TOKEN` (names only).
- `SKILL.md`, `references/eoffice-api.md`, `projects.json.example` — procedure,
  rules reference, example.

## Safety

- The token is read only from the environment and never written to a file, a
  ledger, a draft, or any output. Responses are scrubbed of the token.
- The agent never reads or prints the contents of `.env`. With the user's
  permission it may run a script that loads the env, and only that script sees
  the token.
- Apply prints the host and needs the explicit approval from step 7 each time.
- Production writes stay blocked until the UAT checklist is recorded as done.

## Error handling

- `accesstoken not of object` → name the object that lacks permission; stop.
- Missing env var → exit 2 with the variable name.
- Unresolved or ambiguous person, project, or parent → stop before any write.
- Partial create failure → ledger only confirmed tasks; report the rest.

## Validation

- Unit tests with a mocked `fetch`: template rendering, rules validation,
  payload building, `*_code` values never used as IDs, the token never present
  in output, error mapping.
- UAT checklist (manual, recorded): read the `work-normal-normal` insert
  docs; insert one task with display names, then with raw IDs; confirm date
  format; confirm `status`/`percent` behavior; confirm parent and people
  resolve; confirm the duplicate guard finds the task just created; confirm the
  ledger receives the returned `ID`.
- Production: one supervised task after the UAT checklist passes.

## Observed One Nova rules (history of 39 tasks, 2026-10-12)

- Titles: 24 use `[NVG.ITD - CDS Tập Đoàn] - One Nova - <layer> - <summary>`, 9 use
  `OneNova` (no space). The `[BE]` suffix appears in only 1 of 39. Layers seen:
  BE, Mobile, Web, Meeting.
- Parents are two-level: `2089469` ("[NVG.ITD - CDS Tập Đoàn] - OneNova -P5- Development")
  and its parent `2087612` ("05. One Nova - Phase 5 CDS thư ký - Điểm danh cuộc họp");
  17 tasks under each, 4 without a parent. The `s` filter is fuzzy keyword search,
  so parent search by title is unreliable; hence `parent.candidates`.
- Actual dates equal plan dates for 31 of 39 tasks (median plan span 0 days);
  hence `dates.actualFromPlan`.
- Owner is the user in 36 of 39; assignees are usually the user plus one
  colleague; followers are usually empty.

## Open items

- A UAT token with `work-normal-normal` write permission (the current token
  points at production).
- The saved insert section of the UAT `work-normal-normal` docs.
- Whether `parent` changes per phase (P5, P6, …) is handled by `ask` + `search`;
  no change needed if it stays fixed.
