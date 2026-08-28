# manual platform

No write integration. Used for any project not yet wired to a real platform.

## Draft format

Group candidate tasks by module/area (infer grouping from repo/path structure
in the evidence -- e.g. group by top-level service directory). For each task:

- **Task Name:** short description, prefixed `[BE]`/`[FE]`/etc. if the
  evidence clearly indicates a layer (mirrors nova's task-log convention).
- **Estimate:** inferred date range based on the size/complexity of the
  evidence (state this is inferred, never claim it's a stored value).
- **Actual evidence:** date range actually observed in git/history/checkpoint
  evidence.
- **Suggested log window:** which working day(s) to record this under.
- **Status:** `Done` / `Partial` / `Investigation completed` etc., only when
  the evidence doesn't clearly show full completion.
- **Evidence:** commit hashes / history entries / checkpoint file references
  backing the task.

End the draft with:
- A "Nguon doi chieu" / "Sources" footer listing exactly which evidence types
  were consulted (git log with date range and filtered emails; Claude
  history.jsonl; checkpoint/.remember files) for this project + window.

## Write procedure

1. Save the draft to `<project-root>/task-log-<window-start>-to-<window-end>.md`.
2. Print: "Draft saved to <path>. No platform is wired for this project --
   log it yourself wherever it needs to go."
3. Append each logged task to the ledger with no `externalId`.
