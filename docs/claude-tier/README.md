# Claude Tier

> Part of the [Claude Tier + Codex Tier](../../README.md) repository. Release history: [CHANGELOG](CHANGELOG.md).

A tiny, opinionated Claude Code skill: run **`/tier`** in any project and it
installs a standing *model/effort-tiering* working preference for that
project. From then on, that project runs **quality-first and
cost-efficient** - automatically. By default the rule lands in a
machine-local `CLAUDE.local.md`, so **your repo stays clean** - teammates and
diffs never see your personal preference; `/tier repo` commits it instead
when you want web + mobile coverage too.

Simple on purpose. It doesn't hook, poll, or call anything - it writes one
clear rule into the file Claude Code always reads, and gets out of the way.

## What the rule does

- **Plan and judge on the session's model; execute through pinned
  sub-agents.** The main session's model is frozen at start (the prompt
  cache is keyed by it - switching mid-session measured 20x the cost of the
  same turn; on the 5.5 models and Fable 5.1 an effort change keeps the
  cache), so sub-agents are the tier lever.
- **Derives each route from measured facts, not a table:** tests, builds
  and linters run with no model; work a tool will check goes to Haiku at
  low effort; reading and extraction whose cited items a strong model
  spot-checks go to Haiku at medium (inferred from its measured runs); silent work fully determined by its
  input goes to Sonnet at high; judgment, ambiguous specs, verification and
  design default to **Opus at low effort**. Haiku only goes where its
  mistakes get seen. Re-measured on the 5.5 models (429 graded runs,
  2026-10-24); Opus's edge on ambiguous specs was measured on the 5.0
  generation.
- **Model is the strong lever, effort the weak one.** On the 5.5 models,
  high effort cost Sonnet and Opus 1.0-1.6x low and xhigh 1.1-2x; more effort raised
  quality only where the model was at its limit (Haiku at low on silent
  work). Sonnet 5.5's recalibrated levels put agentic edits at medium.
  `max` is never a default (2-9x the cost of low for no measured gain).
- **Fable 5.1 is an escalation, not a default:** the hardest frontier
  reasoning, high-stakes research, a tie-break after an Opus attempt fails,
  or an explicit request. Measured total cost ran 1.4-1.7x Opus 5 at low by
  task with no quality edge on any shape measured (Opus 5.5 is cheaper still).
  Without Fable on the plan, or without the usage credits it may need, Opus
  at max is the ceiling - the rule never stalls on an unavailable model.
- **Newest model within a tier, always** - same or lower price, better model.
  Today that is Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5; the `opus`,
  `sonnet` and `haiku` aliases resolve to the 5.5 models (checked in Claude
  Code on 2026-10-12), so a full model ID is only needed when an alias lags.
- **Every sub-agent is pinned** (model, effort, tools) and pays a boot cost
  before any work (~9K tokens with a listed toolset on any 5.5 model, 3x
  that with `tools: *`), so small one-shot work stays inline. Independent same-tier
  agents go out in one batch; a pinned-low agent that meets more than its
  brief replies `ESCALATE:` and is re-run one tier up.
- **Routing stays cheap:** the rule is a short list of facts and hard
  constraints, written for the model to read every turn rather than for you.
  Small tasks skip routing entirely and run on the current model.
- **Per-task fit:** *downgrade* clearly mechanical work directly; *upgrade*
  only after asking you first.
- **Hard rule that overrides everything: never compromise quality.** Any doubt
  whether a downgrade would hurt = don't downgrade.

## Install

Three paths - pick the one that matches you.

### 1. New to Claude Code? One command sets up everything

Nothing needs to be installed first - not even Claude Code itself.

**macOS / Linux / Ubuntu / WSL** (any bash shell):

```
curl -fsSL https://raw.githubusercontent.com/thephenyl02-creator/claude-codex-tier/main/install.sh | bash
```

**Windows** (PowerShell):

```
irm https://raw.githubusercontent.com/thephenyl02-creator/claude-codex-tier/main/install.ps1 | iex
```

The installer absorbs everything that usually goes wrong on a fresh machine:
it installs the Claude Code CLI if it's missing, works even when `claude`
isn't on your PATH yet, never depends on your git/SSH setup, and if the
plugin route is still blocked it falls back to copying the skill directly
into `~/.claude/skills/` - no git needed at all. It changes nothing outside
its job: your git config and shell session are left exactly as found. Safe to
re-run any time; it updates an existing install.

### 2. Already have Claude Code? Two commands

From any terminal:

```
claude plugin marketplace add thephenyl02-creator/claude-codex-tier
claude plugin install tier@claude-tier
```

Or the same thing inside a Claude Code session:

```
/plugin marketplace add thephenyl02-creator/claude-codex-tier
/plugin install tier@claude-tier
```

(Typed `/plugin` commands exist only in the terminal CLI. On the **desktop
app**, click **+** next to the prompt box -> **Plugins** -> **Add plugin** ->
add marketplace `thephenyl02-creator/claude-codex-tier` -> install **tier**.)

### 3. Plugin authors & the git-averse: fully native, fully git-free

The marketplace can be added straight from its manifest URL, and the plugin
itself ships as a sha256-pinned zip archive - so the whole chain installs
over plain HTTPS, even on machines with no git or SSH configured:

```
claude plugin marketplace add https://raw.githubusercontent.com/thephenyl02-creator/claude-codex-tier/main/.claude-plugin/marketplace.json
claude plugin install tier@claude-tier
```

**Cloud (claude.ai/code):** cloud sessions have no plugin browser - declare
the plugin in the repo's `.claude/settings.json` instead, and it installs at
session start:

```json
{
  "extraKnownMarketplaces": {
    "claude-tier": {
      "source": { "source": "github", "repo": "thephenyl02-creator/claude-codex-tier" }
    }
  },
  "enabledPlugins": { "tier@claude-tier": true }
}
```

(In a cloud session `/tier` will offer to install in repo mode - untracked
local files don't survive there, so durable coverage needs the committed
`CLAUDE.md`.)

Then, in any project:

```
/tier
```

By default the rule lands in the project's `CLAUDE.local.md` - a
machine-local file Claude Code loads right alongside `CLAUDE.md` - and it's
kept out of version control via `.git/info/exclude`, so even your
`.gitignore` stays untouched. **Nothing about your repo changes.** Your
personal routing preference stays yours instead of being pushed onto every
collaborator.

Want the rule on web (claude.ai/code) + mobile too? Those surfaces only read
committed files, so that coverage requires committing it:

```
/tier repo
```

writes the block into the committed `CLAUDE.md` instead (and offers the
commit).

If the project already carries an **older version** of the rule, `/tier`
upgrades the block in place automatically; if it's already current, it skips.
If an old install lives in your committed `CLAUDE.md`, `/tier` offers to
migrate it out to `CLAUDE.local.md`.

Not inside a git repo? `/tier` still works: the rule lands in the current
directory's `CLAUDE.md` as a machine-local install (sessions launched there
load it; web + mobile only read committed repo config).

## Troubleshooting

Every entry below is a real blocker someone hit installing this. The
one-command installer handles all of them automatically - these are the
manual fixes if you're doing it by hand.

- **`command not found: claude`** - the Claude Code CLI isn't installed, or
  it's installed but `~/.local/bin` isn't on your PATH. Install:
  `curl -fsSL https://claude.ai/install.sh | bash`, then follow its PATH note
  (usually `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc` and open
  a new terminal).
- **`permission denied: ~/.zshrc`** while adding the PATH line - your shell
  profile is owned by root (usually from an old `sudo` mishap). Reclaim it:
  `sudo chown $(whoami) ~/.zshrc`, then retry.
- **`/plugin isn't available in this environment`** - typed `/plugin`
  commands exist only in the terminal CLI. On the desktop app use **+ ->
  Plugins -> Add plugin**; on claude.ai/code use the `settings.json` route
  above.
- **`Host key verification failed` / `No ED25519 host key is known for
  github.com`** during install - git is trying SSH without SSH set up (a
  missing `~/.ssh` also means no key, so fixing `known_hosts` alone won't
  help). Make git use HTTPS for GitHub:
  `git config --global url."https://github.com/".insteadOf "git@github.com:"`
  and retry. The repo is public - HTTPS needs no credentials. (Since 1.6.0
  the plugin itself ships as a zip over HTTPS, so git only comes into play
  when the marketplace was added in `owner/repo` form.)
- **`This plugin uses a source type your Claude Code version does not
  support`** - zip-archive plugins need Claude Code v2.1.224+. Update Claude
  Code (`claude update`) and retry.

## Why "simple is best"

Other routers auto-switch your model mid-session via hooks, or ship complex
config profiles. This one deliberately does neither, and there is now a
measurement behind that rather than a preference.

The prompt cache is keyed by model. Switching it mid-session drops
`cache_read` to zero and forces a full rebuild - measured at **20x the
cost of the identical turn** ($0.017 -> $0.346, on Opus 5, when effort was
also part of the key), with a control turn confirming the cache returned as
soon as the setting was held steady. On the 5.5 models and Fable 5.1 an
effort change now keeps the cache (API key or subscription). An auto-switching
router pays that toll every time it fires. Worse, a cache write costs 20-80x
a cache read for the same tokens (40x on Opus 5.5), so a session that keeps
invalidating pays roughly double list price - not merely losing a discount.

So: one command, one durable rule, no moving parts to break. You stay in
control of the actual model; the rule keeps every session honest about
tiering, and never trades quality for cost.

### See what the rule actually did

`skills/tier/scripts/tier-mirror.py` reads your local Claude Code transcripts
and prints, per model, main-session and sub-agent usage separately: cache
reads and writes, a list-price equivalent, and each agent's context per turn
and share of tool calls spent reading. It spends no model tokens. Claude
Code's `/usage` shows the sub-agent share as a percentage; this breaks it
down per model and per agent. Cache writes are priced from the usage's own
TTL split: 5-minute writes (every sub-agent) at 1.25x input, 1-hour writes
(a subscription's main conversation) at 2x.

```bash
python <skill dir>/scripts/tier-mirror.py --day today
```

### One dependency worth knowing

The `Agent` tool takes a model and an effort on every call, and those
override an agent file's pins, so agent files are optional. They still pay
for themselves one way: an agent with a listed toolset starts about 5x
smaller than one with every tool (see boot cost below). **`/tier` does not
create agent files** - that part is yours.

The seven agents used to measure the rule are published under
[docs/claude-tier/agents/](agents/), one file each:

| Role | Model | Effort | Tools | When |
| --- | --- | --- | --- | --- |
| [adjudicator](agents/adjudicator.md) | `claude-fable-5-1` | high | Read, Grep, Glob, Bash, WebFetch, WebSearch, ToolSearch | last-resort tie-break after an Opus attempt already failed |
| [builder](agents/builder.md) | `opus` | low | Read, Write, Edit, Bash, Grep, Glob, WebFetch, WebSearch, ToolSearch | substantive implementation and design work from a spec |
| [executor](agents/executor.md) | `sonnet` | medium | Read, Write, Edit, Bash, Grep, Glob, ToolSearch | carries out a decision already made, across substantial work |
| [integrator](agents/integrator.md) | `opus` | low | Read, Write, Edit, Grep, Glob, WebFetch, ToolSearch | merges several inputs into one coherent document or decision |
| [scout](agents/scout.md) | `sonnet` | low | Read, Grep, Glob, Bash, WebFetch, WebSearch, ToolSearch | comprehension of bulk material, returning only distilled findings |
| [sifter](agents/sifter.md) | `haiku` | low | Read, Grep, Glob, Bash, ToolSearch | one simple operation repeated across many items |
| [verifier](agents/verifier.md) | `opus` | low | Read, Grep, Glob, Bash, WebFetch, WebSearch, ToolSearch | adversarially checks a claim or change, or finds a root cause |

To use them, clone or download the repo, then copy the seven files into your
personal agents directory.

macOS / Linux:

```
cp docs/claude-tier/agents/*.md ~/.claude/agents/
```

Windows (PowerShell):

```
Copy-Item .\docs\claude-tier\agents\*.md $HOME\.claude\agents\
```

Without git, fetch a single file directly, substituting the agent name:

```
https://raw.githubusercontent.com/thephenyl02-creator/claude-codex-tier/main/docs/claude-tier/agents/<name>.md
```

These files are **not auto-installed by the plugin**, and installing them is
optional. They matter for one reason beyond convenience: the rule's
one-tier-up clause relies on the `ESCALATE:` convention that the five agents pinned below the
ceiling carry, so
a pinned-low agent written without it will guess instead of handing the task
back.

The measurements behind the pins, including why verification and integration
sit on Opus at low effort and why Fable stays escalation-only, are in the
[1.10.0 changelog entry](CHANGELOG.md); the 1.11.0 entry records what moved
when the pins went to the 5.5 models, and 1.11.1 the 5.5 re-measure.

Boot cost is worth knowing before you write these: a sub-agent pays roughly
10K tokens to start with a listed toolset, on any 5.5 model, flat regardless of task size,
so small one-shot work is cheaper done inline however cheap the model. List
the tools you need rather than `*`: a generic agent with every tool started
at ~55K tokens on the measuring machine (2026-10-24), about 5x - the
wildcard loads every tool schema, so it grows with the MCP servers you have
connected.
