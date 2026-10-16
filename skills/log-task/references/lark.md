# lark platform

Writes via the external `lark-cli` binary (not bundled -- the user installs
it separately, same as `git`).

## Required `params` in projects.json

- `baseToken` -- the Lark Base token (e.g. `xxxxxxxxxxxxxxxxxxxxxxxxxxx`).
- `tableId` -- the target table ID (e.g. `tbl0ZxyrZF4XeDD8` for a Task table).
- `prefix` -- short project tag prepended to every record's title field, e.g.
  `[Dominode]`, to disambiguate projects sharing one base.

## Draft format

Same grouping/fields as `manual.md`'s draft, but each task additionally maps
to the target table's field names (ask the user for the table's field list
via `lark-cli base +record-list --format json` if `params` doesn't already
document them, and cache that mapping in `params.fieldMap` for next time).

## Write procedure

1. Build one `--json` field map per candidate task, title prefixed with
   `params.prefix`.
2. Preview: run
   `lark-cli base +record-upsert --base-token <baseToken> --table-id <tableId> --json '<fields>' --dry-run`
   for each task (or `+record-batch-create --dry-run` if the CLI supports
   batching multiple tasks in one call -- check
   `lark-cli base +record-batch-create --help` first).
3. Show the dry-run output to the user, get an explicit second confirmation.
4. Re-run the same command(s) without `--dry-run`.
5. Parse the returned record ID(s) from the command output and append each
   logged task to the ledger with `externalId` set to that record ID.
6. If a record fails, don't retry automatically -- report which task failed
   and why, ledger only the ones that succeeded.
