---
name: tier
description: Install the model/effort-tiering working preference into the CURRENT project — by default into a machine-local CLAUDE.local.md kept untracked via .git/info/exclude, so the user's repo stays clean; with "repo" into the committed CLAUDE.md so web + mobile sessions load it too. Outside any git repo, installs into the current directory's CLAUDE.md. Use when the user wants to make a project/session model-tiered, "add the tiering rule", or types /tier, /tier repo, or /tier local. If the project carries an OLDER version of the rule, upgrade it in place automatically.
---

# Make this project model-tiered

When invoked, install the standing model/effort-tiering rule for the CURRENT
project. There are two install modes — the default keeps the user's repo clean:

- **local (DEFAULT)** — write to `CLAUDE.local.md` at the working tree's root
  and keep it untracked. The rule is a PERSONAL working preference; it must
  never be forced into a shared repo where every collaborator inherits it.
  Local sessions load the file automatically alongside `CLAUDE.md`; web
  (claude.ai/code) + mobile will NOT see it — those surfaces read only
  committed repo files.
- **repo (only on explicit request)** — the user said "repo" or asked for
  web/mobile coverage → write to the committed root `CLAUDE.md`. This is the
  only way the rule reaches web + mobile sessions, and it makes the block
  visible to everyone who clones the repo. State that trade-off in one line
  when installing this way.

Outside a git repo (home directory, scratch space, unversioned code) there is
no repo to keep clean: install into the current working directory's
`CLAUDE.md`. That is machine-local by nature. Do not refuse or skip the
install just because there is no repo — the user asked for tiering where they
are.

The canonical block is written for the model, not for human prose style:
compact, imperative, unambiguous. Install it verbatim — do not paraphrase,
prettify, or reformat it.

## Steps
0. **Global-coverage guard.** Before anything else, check the user-level
   `~/.claude/CLAUDE.md` for the marker `model & effort tiering` (case-insensitive) and its
   `tier-rule vX.Y.Z` tag (skip this check in a cloud sandbox — no user home
   config there):
   - Global tag SAME or NEWER than this skill's canonical block, and LOCAL
     mode → the user is already covered in every local session; a project
     install would load the same ~1,367-token rule TWICE every turn for zero
     benefit. Say so and STOP. Mention that `/tier repo` is the one reason to
     install anyway (web/mobile sessions read only committed repo files).
   - Global tag OLDER than the canonical block → offer to upgrade the GLOBAL
     file in place instead of installing locally — one copy, every project.
     If the user declines, proceed with the normal install below.
   - REPO mode → proceed regardless (web/mobile coverage is the point), but
     note in one line that local sessions in this project will load both the
     global and the repo copy — the accepted price of that coverage.
   - No global block → proceed normally.
1. Pick the mode: the word "repo" (or an explicit ask for web/mobile
   coverage) → repo mode. Otherwise — including an explicit "local" — local
   mode. EXCEPTION: if THIS session is itself running in a cloud sandbox
   (claude.ai/code web or mobile — typical signs: an ephemeral fresh-clone
   workspace path, no user home config; if unsure, ask the user where they
   are running) a local install is not durable — the clone is ephemeral and
   untracked files die with the session. Say so and offer repo mode instead;
   if the user declines, install locally anyway and warn in one line that it
   will not survive the session.
2. Locate the targets at the CURRENT working tree's root, via
   `git rev-parse --show-toplevel` — in a linked worktree that is the
   worktree's OWN root, never the main checkout's:
   - In a git repo → LOCAL target is `<root>/CLAUDE.local.md`; REPO target
     is `<root>/CLAUDE.md`. Always pass the FULL `<root>/...` path to git
     commands below — a bare `CLAUDE.local.md` pathspec silently misses when
     the session's cwd is a subdirectory. In local mode, first check whether
     the file is already TRACKED:
     `git ls-files --error-unmatch -- "<root>/CLAUDE.local.md"` — exit 0 =
     tracked (a tracked file cannot be excluded, so edits to it WILL show as
     a repo change — surface that and ask the user how to proceed before
     writing anything); exit 1 with a "did not match" message is the normal
     untracked answer, NOT an error.
   - NOT in a git repo → the single target is the current working
     directory's `CLAUDE.md`; treat it as local mode, skip step 4, and in
     step 3 ignore the other-file branches (there is only one file — upgrade
     in place there).
3. Search BOTH targets (where they exist) for the marker
   `model & effort tiering` (case-insensitive), then take exactly one branch:
   - **Found in BOTH files** → never finish with two copies. Local mode →
     ask the migrate/keep question below, and EITHER WAY delete the losing
     copy: migrate ⇒ the CANONICAL BLOCK replaces any existing block in
     `CLAUDE.local.md` and the block is REMOVED from `CLAUDE.md`; keep ⇒ the
     old block in `CLAUDE.md` is replaced in place with the CANONICAL BLOCK
     and the block is REMOVED from `CLAUDE.local.md`. Repo mode → install
     the CANONICAL BLOCK into `CLAUDE.md` (replacing its old block) and
     DELETE the block from `CLAUDE.local.md`.
   - **Found only in the file matching the chosen mode** → version check:
     · block contains the tag `tier-rule v1.12.0` → already current. In local
       mode in a git repo, still run step 4 first (verify/repair the
       exclusion — it may be missing even when the block is current), then
       say the project is already tiered and STOP — do not duplicate.
     · older tag, or no tag → REPLACE the entire old block in place — from
       its `## Working preferences — model & effort tiering` heading (any
       heading-suffix variant) through its last line (up to the next `##`
       heading or end of file) — with the CANONICAL BLOCK below. Do this
       automatically, no need to ask; say in one line that you upgraded it.
   - **Found only in the OTHER file:**
     · Local mode in a git repo, block in the committed `CLAUDE.md` (a
       pre-1.6 install) → ASK the user:
       — migrate (recommended): write the CANONICAL BLOCK into
         `CLAUDE.local.md` (replacing any existing tiering block there),
         DELETE the old block from `CLAUDE.md`, run step 4, and note that
         the `CLAUDE.md` edit is a repo change they will want to commit
         (web/mobile coverage is lost);
       — keep: REPLACE the old block in `CLAUDE.md` with the CANONICAL
         BLOCK in place (upgrading it) and follow step 5's repo-mode commit
         reminder.
     · Repo mode, block in `CLAUDE.local.md` → install the CANONICAL BLOCK
       into `CLAUDE.md` and DELETE the old block from `CLAUDE.local.md`.
   - **Found in neither** → fresh install: insert the CANONICAL BLOCK below
     verbatim into the chosen mode's target, near the top (after the
     project's title/intro paragraph if there is one). Create the file if it
     doesn't exist.
4. Local mode in a git repo — keep `CLAUDE.local.md` untracked with ZERO
   repo footprint. Do NOT edit the repo's `.gitignore` — that would itself
   be an uncommitted repo change the user never asked for. Instead:
   - If `git check-ignore -q -- "<root>/CLAUDE.local.md"` exits 0, it is
     already excluded — nothing to do. (Exit 1 is the normal "not ignored
     yet" answer, NOT an error; only exit 128 means the command itself
     failed.)
   - Otherwise resolve the exclude file with
     `git rev-parse --path-format=absolute --git-path info/exclude`, create
     it if absent, make sure it ends with a newline, and append the line
     `CLAUDE.local.md` if it is not already present.
   - Note in passing: `CLAUDE.local.md` itself is per-clone/per-worktree —
     re-run /tier in other clones or worktrees — while the exclude entry is
     per-clone and already covers every worktree of this clone.
5. Repo mode → remind the user to commit `CLAUDE.md` so web + mobile
   sessions pick it up (`git add CLAUDE.md && git commit`), and offer to do
   the commit. Non-repo install → say the install is local to this
   machine/directory, and that repo-mode inside a git repo covers web +
   mobile too.
6. Confirm in one line what you did and into which file.

Maintainer note: any future edit to the canonical block MUST bump the
`tier-rule vX.Y` version tag here AND in step 3's version check, or
auto-upgrade breaks.

## Canonical block (install verbatim)

```markdown
## Working preferences — model & effort tiering
<!-- tier-rule v1.12.0 -->

OBJECTIVE: quality first > fewest tokens that deliver it. Every dispatch = cost decision {who reads, who judges, how many, model, effort}. No routing table: derive from FACTS.

LIMITS (main session, per user message): web research (incl. curl, docs CLIs) always -> a reader helper; inline reading up to ~8K tokens (300+ line file: with a range); inline edits up to 2 files incl. shell writes (a Write <= 150 lines). Bigger work -> a helper with model + effort. User says "do it yourself" => limits off for that message. Local session without a "Tier mod (active" note => tell the user once: Tier mod not running (rule-only mode). Mod on: LIMITS, pins, max/Fable unlock enforced in code; ladder = [tier] note. Web: advice.

FACTS (prices 2026-10-06; runtime 2026-10-24):
- $/MTok in/out/cache_write_1h/cache_read: fable5.1 10/50/20/0.25 | opus5.5 4/20/8/0.2 | sonnet5.5 2/10/4/0.2 | haiku5.5 0.1/0.5/0.2/0.01 (haiku 5x above 100K prompt). 5m write = 1.25x input. Aliases opus/sonnet/haiku -> 5.5, fable -> 5.1 (always newest in tier; full ID only if an alias lags).
- cache TTL: main = 1h on a subscription within plan; 5m on usage credits, API key, cloud, or over the plan limit (CLAUDE_CODE_PROMPT_CACHE_TTL forces 1h, 2x write). Sub-agents always 5m. Fable on usage credits => main 5m (poor main model).
- cost/turn ∝ context: every response re-reads its whole context (base AND each agent, every tool call). write = 20-80x read (sonnet/haiku 20x, opus 40x, fable 80x). FULL rebuild on: idle > TTL | model change (20x the turn, opus5). Effort change keeps it (not Bedrock/Google). Mod keep-warm (1h cache only): per-session, off by default; pings until they cost one rebuild (opus 40 = ~37h).
- agent boot ~10K with listed tools, ~55K general-purpose/workflow (most of a helper's bill) => small one-shot work stays inline; give agents a tool list. Delegate iff work clears the boot AND (tier drops OR material would sit in the base context). Unpinned agent = session model, or CLAUDE_CODE_SUBAGENT_MODEL (call > agent file > env; _FORCE beats every pin; CLAUDE_CODE_EFFORT_LEVEL beats every effort pin). Batched fan-out shares the first prefix.
- quality, 5.5 (429 graded runs, precise specs only): model = strong lever, effort = weak. opus perfect at every effort; sonnet 4/5 at low and medium on a silent bug hunt, clean from high; haiku/low 59/59 tool-checked, missed on silent work (bug hunt 57/59, synthesis 4/10); haiku/medium 23/24. sonnet/high = 0.7x opus/low $/run at equal quality. Effort cost vs low: high 1.0-1.6x (sonnet ~1x), xhigh 1.1-2x, max 2-9x; gains only at a model's limit. 5.0: opus/low held an ambiguous case sonnet failed at low/med/high; low degrades on ambiguity, not difficulty; fable no edge at 1.4-1.7x opus/low; verify: opus/low = fable/low 4/4, sonnet/low 3/4. 5.5 ambiguity untested.
- => pick the MODEL, effort fixed: judgment, ambiguity, verification, design, or unsure = opus/low; silent but fully determined = sonnet/high; strictly tool-checked = haiku/low; reviewable cited items = haiku/medium; xhigh only for demanding agentic work.
- mechanics: `Agent` model + effort per call beat the agent file; effort honored on all 5.5 incl. haiku; `/model` is user-only; per-agent cost: tier-mirror.py or the mod ledger.

CONSTRAINTS (hard):
- doubt a downgrade could hurt => do not downgrade. mechanical => downgrade without asking; upgrade only after saying so.
- session model frozen at start (a switch rebuilds the cache); vary across sessions, never within one.
- pin every sub-agent (model + effort; workflow agent(): model, effort, agentType); tag each hand-off [t=<task>]; helpers = tier-mod:reader / tier-mod:editor if the mod is installed. rate-limited => retry THAT agent on another tier, never unpin globally.
- weak result | `ESCALATE:` reply | failed check => next rung: haiku -> sonnet/high -> opus/low -> rewrite the brief -> opus/xhigh -> opus/max (fable/high if the plan has Fable) -> stop and report; pass the failure on.
- haiku only where its mistakes get seen (a tool check, cited items a judge spot-checks).
- never `max` by default; max and fable5.1 = escalation only: after an opus/xhigh failure of that [t=] task, or when the user asks. Fable unavailable => opus/max is the ceiling; never stall.
- fan-out >= 3 => announce one line first ("6 x sonnet/high"). give each agent the decision explicitly.

ORCHESTRATOR = the base: plans, decides, dispatches, judges, writes the final word; keeps plans/decisions in files (context = size of the task); locates material (grep, line ranges) but never reads bulk into its own context, edits at scale, or verifies raw sources itself.
- cheap reads, strong judges: haiku/medium or sonnet => digest {findings, quotes, paths}; opus/fable judges the digest, opens a source only on doubt. never bulk to a strong agent.
- each agent: gets paths + line ranges (not files); returns a bounded digest (not a dump); finishes in a few turns.
- one verifier per finding. add readers only on a named signal: sources disagree | load-bearing claim single-sourced | high-stakes conclusion.
- tool can prove it => no model judge: bundle the check into the hand-off; the helper reports command + exit code; push stays with the main session.

SESSION MODEL CHANGES ON ITS OWN (limits, fallback) => announce; pause judgment-heavy work; ask the user to restore; re-verify quality-critical decisions from that window.
```
