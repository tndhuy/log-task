# eoffice-api platform

Creates tasks through the `work-normal-normal` API. Credentials come only from
`EOFFICE_BASE_URL` and `EOFFICE_ACCESS_TOKEN`; the agent never reads `.env`.
The user runs, or approves running, every command with
`node --env-file=<path-to-env-file> <script> ...`.

## Config

Platform value `eoffice-api`. Group entries carry `rules`; a child's `rules`
replace the group's per top-level key (a child `done` replaces the whole group `done`).

```json
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
   `node --env-file=<env> <skill-dir>/scripts/eoffice-api-write.mjs search-parent --project-id <projectId> --search "<rules.parent.search>"`.
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
   `YYYY-MM-DD`; unknown keys are ignored. `project.ref` comes from
   `params.projectRef` and `project.id` from `params.projectId`.
   Create a temp directory outside the repo (for example with `mktemp -d`) for
   `batch.json`, `rules.json` and `settings.json`, and delete it after the run;
   never write them into the user's repository.
5. Dry-run (read-only, includes the duplicate guard):
   `node --env-file=<env> <skill-dir>/scripts/eoffice-api-write.mjs create --dry-run batch.json`.
   Show the plan, the host, and any task marked as already existing. Stop on any error.
6. Explicit approval that names the host. Then:
   `node --env-file=<env> <skill-dir>/scripts/eoffice-api-write.mjs create --apply --confirm-host <host> batch.json`.
   Add `--allow-production` only for a non-UAT host, and only when the user
   states in this run that the UAT checklist (`docs/eoffice-api-uat-checklist.md`)
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
9. If UAT shows a status-only route does not reach `percent=100`, run the
   existing `eoffice` `report-progress` flow (separate approval) for the created tasks.

## Errors

- `accesstoken not of object`: the token lacks permission for `work-normal-normal`; stop.
- Missing `EOFFICE_BASE_URL` or `EOFFICE_ACCESS_TOKEN`: exit 2 naming the variable.
- Apply refused (exit 2): wrong or missing `--confirm-host`, or non-UAT host without `--allow-production`.
- Partial failure: exit 1; ledger only the confirmed tasks.
