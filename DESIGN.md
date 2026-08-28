# log-task — Design Spec

Status: approved, not yet implemented.
Date: 2026-08-27

## Problem

The user manually reconciles "what did I actually do" against a per-project
work-tracking platform (timesheet/task board) before logging hours/tasks.
This was done ad hoc for two real projects:

- **nova** → platform **eOffice** (`eoffice.novagroup.vn`). No write API —
  only a web UI. Prior workflow: user provides a screenshot of tasks already
  logged; Claude cross-references git commits (filtered to the user's own
  git emails, both author and committer date), Claude `history.jsonl`/session
  history, Codex memory/rollout summaries, and checkpoint/`.remember` files
  to produce a draft markdown reconciliation
  (see `work/nova/task-log-2026-07-30-to-2026-08-26.md` for the exact shape:
  grouped by module, each task has Estimate / Actual evidence / Suggested
  log window / Status / Evidence, plus a sources footer and an explicit
  "excluded — already visible in screenshot" section). The user previously
  entered the result into eOffice's web UI by hand; this skill now automates
  that entry via a bundled Playwright script (see Architecture) instead of
  stopping at the draft. A prior session already proved that
  `eoffice.novagroup.vn` accepts a cookie-imported session (done then via
  gstack's browser; this skill re-derives the same cookie itself — see
  Platforms), so the session/auth mechanism is proven — only the write flow
  (finding and submitting the task-entry form) is new.
- **happyland-of-draken / dominode** → platform **Lark** via `lark-cli`. Real
  write API: Lark Base "Project management", with a Task table (30 fields)
  and Features table (21 fields), addressed by `base_token` + `table_id`.
  Commands used previously: `base +record-list` (`--format json|markdown`
  only), `base +record-upsert` (`--json` field map; needs explicit
  `--record-id` to update, otherwise always creates a new record — no
  business-key upsert), `base +record-batch-create`, and a `--dry-run`
  preview mode before real writes. Existing convention: records prefixed
  with `[ProjectName]` (e.g. `[Dominode]`) to disambiguate projects sharing
  one base.

Common ground across both: the evidence-gathering pipeline is identical
(own git commits + Claude/Codex history + checkpoints); the destination
platform differs per project and must be declared via config, not
hardcoded; a draft must always be shown for approval before any write;
duplicate detection against already-logged work is required; output is
structured by task name + time range + evidence + project/module grouping.

## Goal

A shareable, global Claude Code skill, `log-task`, invoked manually via
`/log-task`, that runs the shared evidence pipeline, resolves the current
project's target platform from a central config, produces a draft in that
platform's shape, and — after explicit approval — writes it through that
platform's own write procedure. Portability matters: someone installing
this skill should not need gstack, a specific MCP server, or any other
plugin the author happens to have — only Node.js (for `eoffice`) or the
`lark-cli` binary (for `lark`), each declared explicitly.

## Platforms

Three distinct platform values, not two-plus-a-fallback — each project
declares exactly one in `projects.json`:

- **`eoffice`** — writes via a small Playwright script bundled inside the
  skill (`scripts/eoffice-write.mjs`), not gstack's `/browse` and not any
  browser-automation MCP tool. Rationale: this skill is meant to be
  shareable, and both `/browse` (a gstack plugin skill) and MCP browser
  tools (`mcp__playwright__*`, `mcp__claude-in-chrome__*`) are
  environment-specific — a recipient may have none of them configured.
  Node.js + the `playwright` package are a dependency the skill can
  declare and self-check (`package.json`, one-time
  `npm install && npx playwright install chromium`), so it works the same
  way for anyone. Session capture is a **ported copy of gstack's
  `cookie-import-browser.ts`** (MIT-licensed, self-contained — no
  Playwright dependency, only Node built-ins plus `bun:sqlite`, swapped
  for the `better-sqlite3` npm package so it runs under plain Node): it
  reads and decrypts the eOffice session cookie directly from the user's
  real installed Chrome/Chromium (macOS Keychain / Linux libsecret
  decryption, same pipeline gstack uses), then converts it into
  Playwright's `storageState` format. This is easier to operate than an
  interactive headed-browser login — if the user is already logged into
  eOffice in their everyday browser, `log-task` just reuses that, with
  no separate login step at all.
- **`lark`** — writes via the `lark-cli` Open API (dry-run, then real
  write), as already used successfully for dominode's Sprint 4 milestones.
  `lark-cli` is an external binary the user installs themselves, same as
  `git` — not something this skill bundles.
- **`manual`** — no write integration at all. Produces the draft and stops.
  This is the default for any project that hasn't been wired to a real
  platform yet, or genuinely has none (e.g. a personal side project with
  no external tracker).

## Non-goals (YAGNI, explicitly deferred)

- No automatic/proactive triggering (e.g. end-of-session prompts). Manual
  `/log-task` only, for now.
- No formal plugin/adapter registry framework. Three platforms are known;
  the "adapter" is reference docs plus, for `eoffice` only, one bundled
  script — not a generic code interface. Revisit if a fourth platform
  actually shows up.
- No fuzzy/AI-based dedup. Ledger-based exact fingerprint match is enough
  for now.
- No custom 2FA/SSO automation — not needed anyway, since importing the
  cookie from the user's real browser captures whatever login method they
  already completed there (2FA included). If the imported cookie is
  expired/invalid, the fallback is simply "log into eOffice in your normal
  browser, then retry" — no separate headed-login flow to build or
  maintain.
- No support for other browsers beyond what the vendored cookie-import
  module already covers (Chrome/Chromium-family on macOS/Linux/Windows).
  Firefox/Safari cookie stores are a different format — out of scope
  unless actually needed.

## Architecture

Mostly instruction-driven: Claude executes the shared pipeline directly
via Bash/Read/Write, guided by `SKILL.md`, and `lark`/`manual` need no
code at all — each contributes only a reference doc describing its draft
format and write procedure. `eoffice` is the one exception: dependency-free
browser automation cannot be pure instructions, so it ships a small,
self-contained Playwright script instead. This keeps the "no compiled
adapter framework" principle everywhere it can hold, and scopes real code
to the one place it's unavoidable.

## Components

- `~/.claude/skills/log-task/SKILL.md` — entry point for `/log-task`;
  contains the 7-step procedure shared by all platforms (see Data Flow).
- `~/.claude/skills/log-task/projects.json` — central config:
  ```json
  {
    "<project-key>": {
      "platform": "eoffice | lark | manual",
      "gitEmails": ["itc.cv.1@novagroup.vn", "trannguyendanhuy2904@gmail.com"],
      "params": { "...platform-specific, see references/<platform>.md" }
    }
  }
  ```
  `project-key` is the project's absolute root path (or a stable short
  name); `SKILL.md` resolves the current working directory by matching it
  against (or against a prefix of) each key.
- `~/.claude/skills/log-task/references/eoffice.md` — draft format
  (mirroring `task-log-*.md`: module grouping, Estimate / Actual evidence /
  Suggested log window / Status / Evidence, sources footer) plus how to
  invoke `scripts/eoffice-write.mjs` (args, `--dry-run` flag, exit codes)
  and what to do on each exit code (e.g. "no session found" → tell the
  user to log into eOffice in Chrome, then re-run).
- `~/.claude/skills/log-task/scripts/lib/cookie-import.mjs` — ported copy
  of gstack's `browse/src/cookie-import-browser.ts` (MIT license header
  and upstream attribution comment preserved per license terms): reads and
  AES-decrypts the Chromium cookie DB for a given domain (macOS Keychain /
  Linux libsecret key derivation, Chromium epoch conversion — same
  pipeline as upstream), with `bun:sqlite` swapped for the `better-sqlite3`
  npm package so it runs under plain Node. Exposes one function:
  `importCookie(domain) -> Playwright storageState | null`.
- `~/.claude/skills/log-task/scripts/eoffice-session.mjs` — thin wrapper:
  calls `cookie-import.mjs` for `eoffice.novagroup.vn`, writes the result
  to `.eoffice-session.json` (gitignored). Run before the first
  `eoffice-write.mjs` call and again whenever the session has expired —
  no headed-browser login step to build, since it just reuses whatever
  session already exists in the user's real Chrome.
- `~/.claude/skills/log-task/scripts/eoffice-write.mjs` — bundled Node +
  Playwright script. Loads `.eoffice-session.json` as Playwright
  `storageState`, navigates to the task-entry form, and either prints the
  planned fill actions (`--dry-run`) or fills + submits + re-reads the
  page per task to confirm it now appears. Exits with a distinct code for
  "no session" / "session expired" so `SKILL.md` can react instead of
  guessing.
- `~/.claude/skills/log-task/package.json` — declares the `playwright`
  and `better-sqlite3` dependencies; `references/eoffice.md` documents the
  one-time setup (`npm install && npx playwright install chromium`) and
  checks for it before the first `eoffice` run.
- `~/.claude/skills/log-task/references/lark.md` — field mapping per table
  (Task table / Features table field lists), the exact `lark-cli` dry-run
  → write sequence, and the `[ProjectName]` prefix convention.
- `~/.claude/skills/log-task/references/manual.md` — the generic,
  platform-agnostic draft template (same shape as `eoffice.md`'s draft,
  minus the write steps) used for any project with no wired integration.
  Produces a file and stops.
- `~/.claude/skills/log-task/ledger/<project-key>.json` — dedup state:
  ```json
  [
    { "fingerprint": "sha1(...)", "taskName": "...", "loggedAt": "...",
      "platform": "lark", "externalId": "recXXXXXXXXXXX" }
  ]
  ```
  `fingerprint` = stable hash of `project-key + normalized task name +
  evidence commit range`. `externalId` is set when the platform's write
  step returns a stable reference (Lark record ID; an eOffice task/row id
  if the confirmation page exposes one, otherwise omitted); always omitted
  for `manual`.

## Data Flow (the 7 steps `SKILL.md` runs)

1. Resolve `cwd` → `project-key` → look up `projects.json`. If no match,
   stop and ask the user to add an entry (show the expected shape) — never
   guess a platform.
2. Load `ledger/<project-key>.json` (empty array if the file doesn't exist
   yet).
3. Gather evidence: git log over the relevant window filtered to the
   project's `gitEmails` (checking both author and committer date), scan
   Claude `history.jsonl`/session history, scan checkpoint/`.remember`
   files for the same window.
4. Normalize into candidate tasks (name, estimate range, actual evidence
   range, evidence refs, status), then drop any whose fingerprint is
   already in the ledger.
5. Format the remaining candidates using `references/<platform>.md`'s
   template rules.
6. Show the draft to the user. Wait for edits/approval — never write
   without this step.
7. On approval, run the platform's write procedure:
   - **eoffice**: if `.eoffice-session.json` is missing or stale, run
     `node scripts/eoffice-session.mjs` first to (re-)import the cookie
     from the user's real Chrome. Then run
     `node scripts/eoffice-write.mjs --dry-run`, show the planned actions,
     get a second confirmation, then run it for real; if it exits with the
     "no session"/"session expired" code, tell the user to log into
     `eoffice.novagroup.vn` in Chrome, re-run `eoffice-session.mjs`, and
     retry. On success, append entries to the ledger (with an `externalId`
     only if the confirmation page exposes one).
   - **lark**: run `lark-cli base +record-upsert --dry-run` (or
     `+record-batch-create --dry-run` for multiple), show the preview,
     get a second explicit confirmation, run for real, then append
     entries to the ledger with the returned record IDs.
   - **manual**: save the draft file, remind the user where to log it
     themselves, append entries to the ledger (no `externalId`).

## Error Handling

- Unknown project → stop, ask the user to declare it in `projects.json`.
- Platform declared but a required param is missing (e.g. Lark without
  `base_token`/`table_id`) → stop, report exactly what's missing.
- Partial Lark write failure (per-record errors) → only ledger the records
  that actually succeeded; report failures individually, don't silently
  drop or silently retry.
- eOffice browser-write failure (expired session, changed form layout,
  submission rejected) → same partial-success rule as Lark: only ledger
  entries confirmed present after submit; report the rest by name and stop
  rather than guessing at a fixed-up selector.
- `eoffice-write.mjs` reports no/expired session → don't retry
  automatically; tell the user to run `eoffice-session.mjs`, then re-run.
- `cookie-import.mjs` finds no eOffice cookie in any known Chromium
  browser → report plainly "not logged into eoffice.novagroup.vn in
  Chrome/Chromium" and tell the user to log in there first; don't attempt
  a headed-login fallback (out of scope, see Non-goals).
- macOS Keychain access for cookie decryption may trigger an OS permission
  prompt — surface that to the user rather than letting the script hang
  silently waiting on it.
- `node`/`playwright`/`better-sqlite3` missing or
  `npx playwright install chromium` never run → detect this before
  attempting a write (e.g. a clear pre-check in `eoffice-write.mjs`),
  report the exact setup command, don't fail with a raw stack trace.
- No new evidence after dedup → report "nothing new to log" and exit;
  never produce an empty draft.

## Testing / Validation

For `lark`/`manual` there's no compiled code — validation is a dry run
against real data. `eoffice` has an actual script, so it gets both:

- Re-run the evidence-gathering step for nova's already-completed window
  and confirm the shape matches `task-log-2026-07-30-to-2026-08-26.md`.
- For happyland-of-draken/dominode, run through step 6 (draft) without
  ever reaching step 7's real write, and manually check the formatted
  payload against the Task table's 30-field schema before enabling writes.
- For `eoffice-write.mjs`: run once headed (visible browser) against a
  single, low-stakes task and watch the submission happen before ever
  trusting a headless or multi-task run; verify the entry appears
  correctly on the eOffice task list afterward.
- For `cookie-import.mjs`: verify against the real Chrome profile that it
  actually recovers a valid, currently-working `eoffice.novagroup.vn`
  session before wiring it into `eoffice-write.mjs` — test the ported
  module in isolation first.

## Open Items for Implementation

- Exact git log invocation (date window parameterization, author vs
  committer date reconciliation logic) needs to match what was done by
  hand for nova — pull the precise `git log` flags used when that file was
  built, if recoverable, rather than reinventing them.
- `projects.json` needs its first two real entries (nova → eoffice,
  happyland-of-draken/dominode → lark) with real `params` filled in
  (base_token, table_id, gitEmails) before this is usable.
- Porting `cookie-import-browser.ts` → `cookie-import.mjs`: swap
  `bun:sqlite` for `better-sqlite3`, drop the one-line `TEMP_DIR` import
  (inline the two-line platform check instead of vendoring `platform.ts`
  for one constant), and keep the file's original MIT license header plus
  an attribution comment noting it's ported from gstack's
  `browse/src/cookie-import-browser.ts` — required by the MIT license's
  "include the copyright notice" term, and useful so a future reader knows
  where to diff against if gstack fixes a decryption bug upstream.
- eOffice's task-entry form has never been driven programmatically before
  (prior work only proved login/cookie auth via a different tool, gstack,
  not writing) — `eoffice-write.mjs` needs a discovery pass against the
  real form (field names, required fields, submit confirmation signal)
  before it can be written precisely; this belongs in the implementation
  plan as its own investigation step, not guessed at here.
- Decide `.eoffice-session.json`'s exact location and confirm it's
  gitignored if this skill is ever published from a git-tracked directory
  — it holds a live authenticated session and must never be committed.
