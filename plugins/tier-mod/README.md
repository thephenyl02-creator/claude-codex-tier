# Tier mod

The enforcement half of [Claude Tier](../../README.md). The `tier` plugin gives the model a rule; this
mod makes Claude Code hold to it and shows what happened. Full documentation:
[the guide's Tier mod section](../../docs/claude-tier/README.md#the-tier-mod).

## Install

```
claude plugin marketplace add thephenyl02-creator/claude-codex-tier
claude plugin install tier-mod@claude-tier
```

Runs in the desktop app, the terminal and VS Code. The mod is built on the Claude Code mod API, which
is early access and may change between releases. The mod needs Claude Code 2.1.308 or newer. The installers check this; a manual plugin install does not.

## What it does

- Every hand-off names a model and an effort. `max` and Fable unlock only after an opus/xhigh failure
  of the same `[t=]` task, or when you ask.
- Web work (including Bash or PowerShell fetches), reads past ~8K tokens per message, files of 300+
  lines without a range, and edits past 2 files go to `tier-mod:reader` / `tier-mod:editor`.
  "do it yourself" lifts the limits for that message.
- A ledger records what each hand-off cost, its check's exit code, and what it saved.
- A footer button, a hover strip and a side pane show spend, savings, the ladder and the cache, with
  an opt-in per-session keep-warm.
- Health is written to `~/.claude/tier-mod-status.json`; a broken part fails open and shows a red chip.

## Settings

`userConfig` in `.claude-plugin/plugin.json`. Claude Code may print '5 userConfig options not yet set' after install. Ignore it: every setting has a default and the mod works unconfigured. To change one, run /plugin configure tier-mod@claude-tier.

| Setting | Default | Meaning |
| --- | --- | --- |
| `enforce` | `true` | `true` blocks calls over the limits; `false` only logs them. |
| `readTokens` | `8000` | Inline reading allowance per user message. |
| `readLines` | `300` | Files this long or longer need a line range. |
| `editFiles` | `2` | Inline edited files per user message. |
| `facts` | `auto` | `auto` adds the rule's facts to the session; `off` does not. |

## Tests

From this folder:

```
claude plugin test .             # runs every *.test.ts / *.test.tsx; needs no generated files
claude plugin validate .
node scripts/check-version.mjs   # hooks/version.ts must equal .claude-plugin/plugin.json
```

## API types for tsc

The engine writes `.claude-plugin/types/claude-code/index.d.ts` (about 855 KB, version specific)
beside a mod it loads from a folder you own. It is only needed for `tsc` and editor typing. It is not
committed (`.gitignore`); to regenerate it, load this folder as a mod with a current Claude Code. The
release zip carries `types/index.d.ts` (the mod's own declarations) but no tests.

## License

MIT, see [LICENSE](../../LICENSE). Copyright Fenil K Ventures LLC.
