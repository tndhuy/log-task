# eoffice-api platform

Creates tasks through the `work-normal-normal` API. Credentials come only from
`EOFFICE_BASE_URL` and `EOFFICE_ACCESS_TOKEN`; the agent never reads `.env`.
Optional session cookie enables the progress-report record: either `EOFFICE_SESSION_COOKIE`
(passed inline, never stored) or `--session-from brave|chrome` on `create --apply`, which reads
the eOffice host's cookies from the browser profile in memory (macOS asks for Keychain
access; sign in to eOffice in that browser first). It enables the progress-report record, which the integration API cannot create.

## Verified write flow (UAT)

Per task: `insert` (no `status`; enums as display values; people in the format the environment
resolves (UAT: usernames, production: display names, see "Production behaviour");
`project_id` = project code) → wait 3 s → ONE of:
- with a session cookie: `update status="Đang thực hiện"` (the server refuses a report while the task is PENDING), wait, then `POST /work-task-task/progress` (CSRF taken from the
  `csrf-token-cache` response header of a `reloadCsrfToken=1` request). This writes the
  report record (date, reporter, 100%, note).
- without it: exactly one `update` with `ID` and `status="Đang đánh giá"`
  (REVIEW, 100%, actual dates filled, but no report record).
Every further `update` wipes the actual dates; never add one. The server also refuses reports (and hides the UI button) on subtasks and on tasks that
have subtasks, so the CLI sends a status update for those and a report only for a task
with no children that is not itself a child (verified on UAT: 14113 reported, 14119 not).
A task that is already
REVIEW refuses a progress report ("không có quyền"). Tasks without an assignee trigger
an automatic warning, so the CLI refuses empty `assignees`.
The user runs, or approves running, every command. The CLI loads
`<data-dir>/eoffice.env` by itself (`$LOG_TASK_HOME`, else `~/.config/log-task`), so no
flag is needed; variables already exported in the shell win over the file. To target
another environment (for example production), pass `--env-file <path>` to `node`
before the script. Write it as two words: `--env-file=~/x` is not expanded by zsh or bash,
so use `--env-file "$HOME/x"`.

## Config

Platform value `eoffice-api`. People values (`owner`, `assignees`, `followers`) use the format
of the environment the env file points at: display names on production, usernames on UAT. Group entries carry `rules`; a child's `rules`
replace the group's per top-level key (a child `done` replaces the whole group `done`).

```json
"rules": {
  "nameTemplate": "[NVG.ITD - CDS Tập Đoàn] - One Nova - {layer} - {summary}",
  "layer":     { "mode": "fixed", "value": "BE" },
  "parent":    { "mode": "ask", "remember": true, "candidates": [
                  { "id": 2089469, "label": "OneNova -P5- Development" },
                  { "id": 2087612, "label": "05. One Nova - Phase 5 CDS thư ký - Điểm danh cuộc họp" } ] },
  "owner":     { "mode": "ask", "default": "<Your Display Name>", "remember": true },
  "assignees": { "mode": "ask", "default": ["<Your Display Name>", "<Colleague Display Name>"], "remember": true },
  "followers": { "mode": "fixed", "value": [] },
  "dates":     { "actualFromPlan": true },
  "done":      { "status": "REVIEW" }
}
```

- `fixed`: used as is. `ask`: prompted once per run; the pre-selected value is
  the remembered one, else `default`, else (for `parent`) the first `candidates` entry.
- `parent.candidates`: array of `{ id, label }` (at least one). Preferred over
  `parent.search`, because the API `s` filter is fuzzy keyword search and a
  title search for the parent is unreliable. `candidates` is only valid on `parent`.
- `dates.actualFromPlan: true`: a task without `start`/`end` but with
  `startPlan`/`endPlan` gets its actual dates from the plan dates; an explicit
  `start`/`end` always wins. Without the flag nothing is added.
- `layer` varies per task (BE, Mobile, Web, Meeting): set `layer` on each task in
  the batch; `rules.layer` is only the fixed default.
- `nameTemplate` has no `[{layer}]` suffix by default; add one only if the user asks.
- Variables in `nameTemplate`: only `{layer}` and `{summary}`.
- `params.projectRef` is the value sent as `project_id` on insert (the project
  code or the raw ID, decided by the UAT checklist). `params.projectId` is the raw
  project ID used for the parent search. Read both once from an existing task
  of the project with `field_raws=allfield`. Never use a `*_code` value as an ID.

## Observed pattern (One Nova)

From the user's 39 tasks in project 3869: titles follow
`[NVG.ITD - CDS Tập Đoàn] - One Nova - <layer> - <summary>` (24 with "One Nova",
9 with "OneNova"; the `[BE]` suffix in only 1). Parents are two-level (`2089469`
under `2087612`), 4 tasks have none. Actual dates equal plan dates for 31 of 39
tasks. The owner is the user in 36 of 39; assignees are usually the user plus one
colleague; followers are usually empty.

## Draft format

Same grouping as `manual.md`, plus for each task the rendered title, parent,
owner, assignees, plan dates (Estimate), actual dates (Actual evidence), and the
target host. Only `Done` tasks may be created.

## Procedure

1. Settings plan, from the target's `rules` saved to a temp file:
   `node <skill-dir>/scripts/eoffice-api-state.mjs settings-plan --rules <rules.json> --state <statePath>`.
2. Parent candidates. If `rules.parent.candidates` is set, show those (labels)
   and skip the search. Otherwise (read-only):
   `node <skill-dir>/scripts/eoffice-api-write.mjs search-parent --project-id <projectId> --search "<rules.parent.search>"`.
   The "at most 5" cap applies to `search-parent` results only; always show
   every configured `candidates` entry. Either way, pre-select the remembered one (else the plan's
   `preselected`) and let the user pick.
3. Ask owner and assignees once for the run (pre-selected values from step 1).
4. Build `batch.json` (`rules`, `project: { ref, id }`, `settings`, `tasks`) and
   show the draft. Wait for explicit approval. The batch `settings` only needs
   the user's answers for `ask` fields: the write CLI fills every rules field
   that is `mode: "fixed"` (parent, owner, assignees, followers) into `settings`
   when `settings` omits it, and explicit `settings` values win over fixed
   rules. `settings.parent` is required after that merge; the CLI exits 2 without it.
   Each task in `tasks` needs `summary` (required) and may have `layer` (overrides
   the fixed `rules.layer`) and `startPlan`, `endPlan`, `start`, `end` as
   `YYYY-MM-DD`; unknown keys are ignored. A task may carry `children: [{ summary, layer?,
   startPlan, endPlan, start, end, note? }]` (one level only; nested children are rejected, exit 2): each child is created under the
   new task (same project, people and name template, `layer` inherited from the parent
   task unless set). Children are finished before the parent. Results nest as
   `children: [...]`; if the parent fails its children are reported as not created; on a
   rerun an existing parent/child is skipped as "already exists" and missing children are
   added. Ledger the parent task; a child is ledgered only when its own `submitted` is true. `project.ref` comes from
   `params.projectRef` and `project.id` from `params.projectId`.
   Create a temp directory outside the repo (for example with `mktemp -d`) for
   `batch.json`, `rules.json` and `settings.json`, and delete it after the run;
   never write them into the user's repository.
5. Dry-run (read-only, includes the duplicate guard):
   `node <skill-dir>/scripts/eoffice-api-write.mjs create --dry-run batch.json`.
   Show the plan, the host, and any task marked as already existing. Stop on any error.
6. Explicit approval that names the host. Then:
   `node <skill-dir>/scripts/eoffice-api-write.mjs create --apply --confirm-host <host> batch.json`.
   Add `--allow-production` only for a non-UAT host, and only when the user
   states in this run that the UAT checklist (`docs/uat-checklist.md`)
   is complete; never add it in response to a refusal message.
7. Parse the last output line. For each result with `submitted: true` or
   `skipped: "already exists"`, ledger the task with `externalId`. The ledger
   fingerprint uses the normalized `{summary}`, not the rendered title.
   - A result with `created: true` and `submitted: false` means the task was
     created but could not be confirmed. Do NOT ledger it yet. Rerun
     `create --dry-run` for the same batch first. If `plan[].duplicate` shows
     the task as existing, ledger it with that `duplicate.id`; if it does not
     show, STOP and have the user check the eOffice UI (never rerun `--apply`,
     it would create a second copy). A whole-batch rerun reports already-ledgered
     tasks as "already exists"; append to the ledger only fingerprints that are
     not already present.
   - A result with `error: "people not resolved: ..."` is also `created: true`,
     `submitted: false`: the server dropped the owner or assignees, the task stays at
     its default status, and the batch stopped. Never ledger it. After the user approves,
     remove it with `delete --dry-run` then `--apply` (see "Get and delete") and recreate
     the batch with people in the environment's format.
   - Show every result with an ID together with its `link` (when the template is set).
   - Results with `skipped: "duplicate title in batch"` are not ledgered twice
     (one task only).
   - Report each failure by task name; never retry with altered data.
8. Save the run's choices. First write the run's chosen `settings` (the same
   object embedded as `batch.settings`) to a `settings.json` file, then run:
   `node <skill-dir>/scripts/eoffice-api-state.mjs remember --rules <rules.json> --state <statePath> --settings <settings.json>`.
   For group runs, use one `batch.json`, one rules file and one state file PER
   TARGET; run `create --dry-run` for EVERY target first and stop the whole group
   if any dry-run fails; only then run `--apply` per target, each needing its own
   approval naming the host.
9. The result of each task carries `report` (`progress-report` or `status-update-only`),
   plus the read-back `status` and `percent`. A task reported as `created: true` with
   `error: "created but not finished: ..."` exists but the report or status step failed:
   do not rerun `--apply` (the duplicate guard would skip it); finish it in the UI.

## Get and delete

Both are read through `GET /api/work/normal/item`; a missing task answers `Post not found`.

- `get --ids 1,2 [--raw]` (read-only, no host gate): prints `{ id, found, title, status, percent,
  startPlan, endPlan, start, end, owner, assignees, creator, parentId, link }` per ID. Exit 1 if any
  ID was not found.
- `delete --dry-run --project-id <raw project id> --ids 1,2` classifies each ID:
  `absent` (nothing to do), `refused` (another project, or not created by the API account
  unless `--allow-foreign`) or `deletable`. `--project-id` is the raw `params.projectId`, not
  `projectRef`; `EOFFICE_PROJECT_ID` is the fallback.
- `delete --apply --confirm-host <host> [--allow-production] --project-id ... --ids ...` uses the
  same host gate as `create`. It reclassifies first and exits 2 before any call when an ID is
  refused; otherwise one `delete` call per ID (`delIds=<id>`, never a list), then a read-back.
  An ID that is still present after `error: false` stops the run (`still present`).
- Ledger after a delete: keep the entry, set `deletedAt`, add `excluded: "<reason>"` when the work
  is out of scope, and give a recreated task the new `externalId` plus `replaces: <old id>`.
- Links are built from `EOFFICE_TASK_URL_TEMPLATE` (`{origin}` and `{id}`); production value
  `{origin}/work-normal-normal/view?ID={id}`. Without it results carry no `link` and one hint line
  is printed. The ledger stores `externalId` only.

## Production behaviour (observed 2026-10-16)

Evidence and open points: `docs/eoffice-api-production-findings.md`. Sample sizes are small.

- **People.** Production resolves display names; usernames and numeric IDs are dropped silently
  (`insert` still answers `error: false`). The CLI therefore reads the task back after `insert`
  and stops the batch when owner or assignees are missing or only partly stored.
  Display names are not guaranteed unique.
- **Dates.** The REVIEW status update sets the actual dates to the run date, so
  `dates.actualFromPlan` has no lasting effect on production.
- **Creator.** API-created tasks belong to "Admin Hệ Thống" (`created_by_id` 1), with no
  department. Reports that filter by creator may not count them.
- **`gets` filters.** `ID`, `id` and `ids` filters are ignored; never find a task by ID with `gets`.

## Errors

| API response | Meaning | What to do |
|---|---|---|
| `not object` | token unknown, truncated, or its API key has no object for `work/normal` | compare the token length with the admin page; check "Last access time"; retry once if the admin just edited the key |
| `action not scopes` | the key can read but lacks this action | ask the eOffice admin to grant insert/update on `work/normal` |
| `Post not found` (`item`) | no task with that ID | treated as absent by `get` and `delete` |
| `no_action` | unknown action name | none; the CLI does not send unknown actions |

The CLI appends these hints to the message. `doctor --online` makes one read call (`limit=1`) and
shows the same hint before a run.

- Missing `EOFFICE_BASE_URL` or `EOFFICE_ACCESS_TOKEN`: exit 2 naming the variable.
- Apply refused (exit 2): wrong or missing `--confirm-host`, or a host that is not in the UAT allowlist without `--allow-production`. The allowlist is the exact host list in `EOFFICE_UAT_HOSTS` (comma-separated); when unset it is `eoffice-uat.novagroup.vn`. Lookalike hosts such as `prod-uat.corp.com` are not UAT.
- Partial failure: exit 1; ledger only the confirmed tasks.
