---
name: log-task
description: Log completed work into a project's declared platform (eoffice, lark, or manual). Trigger: /log-task
---

# log-task

Invoked via `/log-task`. Runs the 7-step procedure below every time -- do not
skip steps or shortcut the approval gate in step 6, even if the user seems
to be in a hurry.

## Step 1: Resolve the project

Run `pwd` to get the current working directory. Read `projects.json`. Find
the config key that is a prefix of the current directory (if more than one
matches, use the longest). If none matches, stop and show the user this
template to add:

    "<absolute-path-to-project-root>": {
      "platform": "eoffice" | "lark" | "manual",
      "gitEmails": ["you@example.com"],
      "params": {}
    }

Never guess a platform for an unlisted project.

## Step 2: Load the ledger

Compute the ledger path: strip the config key's leading `/`, then replace
every remaining `/` with `-`; call the result `<ledger-key>` (e.g.
`/tmp/log-task-dogfood-repo` -> `tmp-log-task-dogfood-repo`, and a nested key
like `/Users/x/work/nova` -> `Users-x-work-nova`). Read
`ledger/<ledger-key>.json`. If the file doesn't exist, treat it as `[]`.
Reuse this exact path in Step 7 -- don't recompute it differently there.

## Step 3: Gather evidence

Ask the user for the date window if not already given (e.g. "log everything
since my last run" or an explicit range).

**Git commits**, run inside the project root, once per configured email.
`--since`/`--until` filter by COMMITTER date ONLY, regardless of whether you
also pass `--author` or `--committer` -- they do NOT implement an
author-date check, and a commit authored inside the window but rebased or
re-committed later (committer date now outside the window) would otherwise
be silently invisible. So: widen `--since` by ~14 days as a coarse
pre-filter purely to keep the output small, then do the real window check
yourself, client-side, on both dates:

    git log --all --since="<window-start minus 14 days>" --until="<window-end>" \
      --author="<email>" --date=iso-strict \
      --pretty=format:'%H|%ad|%cd|%an|%s'

    git log --all --since="<window-start minus 14 days>" --until="<window-end>" \
      --committer="<email>" --date=iso-strict \
      --pretty=format:'%H|%ad|%cd|%an|%s'

Union the two passes by commit hash (dedupe), then, from that combined set,
keep ONLY commits where the author date (`%ad`) OR the committer date
(`%cd`) falls within the REAL requested window
(`<window-start>`..`<window-end>`). This client-side OR-check -- not the
`--since`/`--until` flags -- is what actually implements "checking both
dates," and is what catches the rebase/cherry-pick case.

**Claude prompt history**, filtered to this project and window:

    jq -c --arg proj "<project-root>" \
      'select(.project == $proj)' ~/.claude/history.jsonl

  Then filter the results to the window by comparing each entry's
  `.timestamp` (epoch milliseconds) against the window's start/end.

**Checkpoint / daily notes**, if present:

    ls <project-root>/.remember/today-*.done.md <project-root>/.checkpoint/*.md 2>/dev/null

  Read whichever of these fall inside the window.

## Step 4: Normalize and dedupe

From the raw evidence, synthesize candidate tasks: a short name, an inferred
estimate range, the actual evidence date range, a status if not clearly
"Done", and which evidence backs it. This is judgment, not a script -- match
the shape and rigor of
`/Users/trannguyendanghuy/Workspace/work/nova/task-log-2026-07-30-to-2026-08-26.md`
(grouped by module, Estimate / Actual evidence / Suggested log window /
Status / Evidence per task, sources footer at the end).

Before fingerprinting, normalize the task name so a fresh run's wording
doesn't silently miss a match: lowercase it, strip any leading layer tag
(`[BE]`, `[FE]`, etc.), and collapse repeated whitespace.

For each candidate, compute a fingerprint over its full set of backing
commit hashes, sorted and comma-joined (not just the oldest/newest -- a
squashed or partially cherry-picked evidence set should still match):

    echo -n "<project-key>|<normalized-task-name>|<sorted-comma-joined-commit-hashes>" | shasum -a 1 | cut -d' ' -f1

Drop any candidate where EITHER:
- its fingerprint already appears in the loaded ledger (**fingerprint
  match**), OR
- ALL of its backing commit hashes are found within a SINGLE existing
  ledger entry's `evidenceCommits` array -- i.e. one ledger entry's
  `evidenceCommits` is a superset of this candidate's commit set
  (**commit-subset match**; this still catches a match even if the
  synthesized name drifted between runs). Do NOT drop a candidate whose
  commits are merely scattered across the `evidenceCommits` of *multiple*
  different ledger entries -- that's a genuinely new cross-cutting task, not
  a duplicate, since one commit can legitimately back more than one logged
  task.

List every dropped candidate in your working notes together with which rule
dropped it (fingerprint match vs. commit-subset match, and which ledger
entry/fingerprint it matched) -- never drop one silently. If, after this
pass, no candidates remain, report "nothing new to log" (including the
dropped-candidate list, mirroring nova's own task-log convention of an
explicit "excluded because already logged" section) and stop -- never
produce an empty draft.

## Step 5: Format the draft

Read `references/<platform>.md` for the resolved platform and follow its
"Draft format" section exactly.

## Step 6: Get approval

Show the full draft to the user. Wait for explicit approval or edits. Never
proceed to Step 7 without it, regardless of how the request was phrased.

## Step 7: Write

Follow `references/<platform>.md`'s "Write procedure" section exactly. After
it completes (fully, partially, or not at all -- manual's "write" is just
saving a file), append every successfully-logged task to the same ledger
file resolved in Step 2 (`ledger/<ledger-key>.json`), with the fingerprint
computed in Step 4 and an `evidenceCommits` array of every backing commit
hash (needed for Step 4's commit-anchored dedup check on future runs), then
write the file back.
