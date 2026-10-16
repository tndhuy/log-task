# log-task

An agent skill that turns your finished work (git commits, Claude Code history,
checkpoints) into task records on the platform each project declares:
**eOffice** (API), **Lark Base**, or a **manual** markdown file. Invoke it with
`/log-task`. Nothing is written until you approve the draft.

## Install

Requires Node.js 22.13 or newer. No `npm install` is needed.

```bash
npx skills add tndhuy/log-task            # interactive: pick your agents
npx skills add tndhuy/log-task -a claude-code -g -y   # Claude Code, all projects, no prompts
```

Update later with `npx skills update log-task`. Your configuration is stored
outside the skill directory, so updates never overwrite it.

## Configure (once, about 5 minutes)

1. Create the data directory and copy the example config:

   ```bash
   mkdir -p ~/.config/log-task
   cp ~/.claude/skills/log-task/assets/projects.json.example ~/.config/log-task/projects.json
   ```

   Set `LOG_TASK_HOME` to use a different directory.

2. Edit `projects.json`: one entry per project, or one `"type": "group"` entry
   for a workspace folder that holds several repos. `gitEmails` selects which
   commits are yours.

3. For `eoffice-api` projects, copy `~/.claude/skills/log-task/assets/env.example` to a private file, fill in
   `EOFFICE_BASE_URL` and `EOFFICE_ACCESS_TOKEN`, and pass it to the commands the
   skill proposes with `node --env-file=<path>`. The agent never reads that file.

## Use

Open your agent in a project (or in the group folder) and run `/log-task`.
The skill resolves the project, gathers evidence for the date window you give,
drops work that is already in the ledger, shows a draft, and writes only after
you approve. Production eOffice writes need an explicit instruction in the run.

## Platforms

| Platform | Writes to | Reference |
|---|---|---|
| `eoffice-api` | eOffice tasks via the integration API, with per-project naming rules | `skills/log-task/references/eoffice-api.md` |
| `lark` | a Lark Base table | `skills/log-task/references/lark.md` |
| `manual` | a markdown file you copy from | `skills/log-task/references/manual.md` |

## Development

```bash
npm test      # Node's built-in test runner, no dependencies
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout and conventions.

## License

[MIT](LICENSE)
