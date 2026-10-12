# Group log-task — Design Spec

Status: draft, awaiting review.
Date: 2026-10-12

## Problem

`/log-task` resolves exactly one project from `cwd`. The user works from a
workspace root (e.g. `nova`) that holds several repos and logs all of them in
one sitting. Today that means one run per repo, and the dedup ledgers end up
scattered in the skill's own `ledger/` directory, away from the work.

`DESIGN.md` lists multi-repo scanning as a deferred non-goal. This spec
reverses that for the group case only; the single-project flow is unchanged.

## Goals

- Run `/log-task` once from a group root and log every child repo.
- Each child repo maps to its own eOffice Project.
- Keep all group state (ledgers, approved drafts) in one folder under the root.
- Running `/log-task` inside a single child repo must not re-log what a group
  run already logged, and vice versa.

## Non-goals

- No automatic repo discovery. Children are declared explicitly.
- No per-child platform override; a group has one platform.
- No change to the single-project flow, `lark`, or `manual` behavior.
- No change to `scripts/eoffice-write.mjs` modes or its two-gate approval.

## Config

A group entry in `projects.json`:

```json
"/abs/path/nova": {
  "type": "group",
  "platform": "eoffice",
  "gitEmails": ["you@example.com"],
  "logDir": ".log-task",
  "params": {
    "defaultAssignor": "...", "defaultAssignee": "...",
    "defaultFollower": "...", "defaultCollaborator": "..."
  },
  "children": {
    "api":  { "params": { "project": "<eOffice project name>" } },
    "web":  { "params": { "project": "<eOffice project name>" },
              "gitEmails": ["other@example.com"] }
  }
}
```

- `children` keys are paths relative to the group root; each is a git repo.
- Child `params` and `gitEmails` override the group's, field by field.
- `params.project` is required per child (the eOffice Project name).
- `logDir` is relative to the group root and defaults to `.log-task`.
- Entries without `"type": "group"` behave exactly as today.

## Resolution (Step 1)

1. Pick the longest config key that prefixes `cwd`.
2. If it is a standalone entry: unchanged.
3. If it is a group and `cwd` equals the root (or is not inside any child):
   **group run** over every child.
4. If it is a group and `cwd` is inside a child: **single-child run** for that
   child, using the merged child config and the group's `logDir`.
5. Any child directory missing or not a git repo: stop and name it. Never skip
   a declared child silently.
6. If a child's absolute path is also a top-level config key (or a child of
   another group), stop and name both entries. One repo must have exactly one
   owner, otherwise its ledger would split and tasks would be logged twice.

## State layout

```
<group-root>/.log-task/
  ledger/<child-rel-path with "/" → "-">.json
  drafts/<window-start>_<window-end>_<HHmmss>.md
```

The time suffix keeps a re-run over the same window from overwriting an
earlier approved draft.

- Ledger entries keep the existing schema. The fingerprint's `<project-key>`
  is the child's **absolute path** (group root + relative path). This equals
  the key the same repo used as a standalone entry, so old fingerprints stay
  valid and group/single runs dedupe each other.
- A draft file is written after approval, before any external write.
- Ledger writes keep the temp-file + rename rule.
- If `<group-root>` is itself a git repo, add `.log-task/` to its
  `.gitignore` (ask first; do not edit silently).

## Procedure (group run)

Steps 2–4 run once per child; Steps 5–7 run once for the whole group.

1. Resolve (above).
2. Load each child's ledger from `logDir/ledger/`.
3. Ask the date window once. Gather evidence per child, in the child's repo,
   with the child's merged emails (existing git/history/checkpoint rules).
   Claude history is filtered by the child's absolute path.
4. Normalize and dedupe per child, same fingerprint and commit-subset rules.
   Report dropped candidates per child.
5. If no child has new candidates: report "nothing new to log", stop.
6. Draft: one document grouped **child → module → task**, using
   `references/eoffice.md` format, with each child's resolved eOffice Project
   shown. Children with nothing new are listed as "nothing new". Wait for
   explicit approval or edits. Save the approved draft to `logDir/drafts/`.
7. Write, using the existing eOffice procedure with one change: the task JSON
   batches carry each task's child `project`. The two gates stay separate:
   - **Gate 1**: `create-task --dry-run` for the whole batch, then approval,
     then real run. The dry-run validates input and the local form map
     only (it does not contact eOffice). If it fails for any child, stop the
     whole batch before any real create and name the failing child. An unknown
     eOffice Project is not caught by the dry-run: it surfaces at the real
     create as a per-task failure, reported by task name, never retried with
     altered data; only confirmed tasks are ledgered.
   - **Gate 2**: `report-progress --dry-run`, separate approval, real run.
   Append a task to its **child's** ledger only after all required steps for
   that task succeed. A failure in one child does not block ledgering the
   others; report failures by task name.

## Ledger migration

One-off, before loading the ledger of any run (group or child) that touches a child with an old skill-dir ledger; a child run must not start from an empty ledger and re-log old work:

1. For each declared child, compute its old ledger key from its absolute path
   (existing rule: strip leading `/`, replace `/` with `-`).
2. List `ledger/<old-key>.json` → `logDir/ledger/<new-key>.json` moves, show
   the list, and wait for approval.
3. Move only approved files. Never overwrite an existing destination; if one
   exists, stop and ask.
4. Also look for a ledger keyed by the group root's own path. It matches no
   child, so list it and ask the user how to handle it (leave it, or archive
   it under `logDir/ledger/_legacy-root.json`). Its fingerprints are not
   applied to any child automatically.

## Error handling

- Missing `params.project` on a child → stop, name the child.
- Missing people defaults at group and child level → stop and ask, never guess
  (existing rule).
- Child repo missing or not a git repo → stop, name it.
- Session errors from `eoffice-write.mjs` → existing handling; no retry.
- Partial write → ledger only confirmed tasks, per child.

## Files changed

- `SKILL.md`: group-aware Step 1, per-child Steps 2–4, group Steps 5–7,
  `logDir` ledger path, migration step.
- `references/eoffice.md`: group draft layout and per-task `project`.
- `projects.json.example`: add a group entry.
- `DESIGN.md`: replace the multi-repo non-goal with a pointer to this spec.
- `scripts/resolve-project.mjs`, `scripts/lib/resolve-project.mjs`, `scripts/lib/ledger-migration.mjs` (deterministic resolution, ownership check, migration planning, with tests).
- No change to `eoffice-write.mjs`; it already takes `project` per
  task (confirmed: `fixtures/eoffice-create.example.json`, form map `locatorValueField`).

## Validation

- Dry run from a group root with two children: confirm per-child evidence,
  grouped draft, and that no write step is reached without approval.
- Run inside one child after a group run: expect "nothing new to log".
- Migration: confirm a pre-existing child ledger moves and its fingerprints
  still dedupe.
- Gate 1 and Gate 2 each run as `--dry-run` against `fixtures/` before any
  live mutation; the live headed check from `DESIGN.md` still applies.
