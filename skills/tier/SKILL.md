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
     install would load the same ~1,100-token rule TWICE every turn for zero
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
     · block contains the tag `tier-rule v1.11.0` → already current. In local
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
<!-- tier-rule v1.11.0 -->

OBJECTIVE: quality first (never downgrade work that needs a strong model) > fewest tokens that deliver it. Every dispatch = cost decision {who reads, who judges, how many, model, effort}. No routing table: derive from FACTS. Small task (1 tool call + 1 reply) => skip routing.

FACTS (list prices 2026-10-06; runtime facts verified in Claude Code 2026-10-12):
- $/MTok in/out/cache_write/cache_read on the 1h cache: fable5.1 10/50/20/0.25 | opus5.5 4/20/8/0.2 | sonnet5.5 2/10/4/0.2 | haiku5.5 0.1/0.5/0.2/0.01 (prompt <= 100K; 5x above). Always newest model in tier. Aliases opus/sonnet/haiku -> 5.5, fable -> 5.1; pin a full ID only when an alias lags.
- cost/turn ∝ context: every response re-reads its whole context (base AND each agent, every tool call). write = 20-80x read (sonnet/haiku 20x, opus5.5 40x, fable5.1 80x). FULL rebuild on: idle > 1h | any model/effort change (measured 20x the turn on opus5; 40x by opus5.5 prices). Thrashing ≈ 2x list.
- agent boot ~9K with listed tools (same on haiku/sonnet/opus 5.5), x3 with `tools: *` => small one-shot work stays inline. Delegate iff work clears the boot AND (tier drops OR material would sit in the base context). Unpinned agent = session model. Batched fan-out shares the first prefix.
- quality (125 graded runs on opus5/sonnet5/haiku4.5/fable5.1; not re-run on 5.5): model = strong lever, effort = weak. opus/low held the ambiguous edge case sonnet failed at low/med/high; precise specs: every tier passed; low degrades on ambiguity, not difficulty. effort: cost 1.3-1.6x, correctness rarely. max: 2-5x low, no correctness gain. fable5.1: no quality edge, 1-2x opus5/low cost; verification opus/low = fable/low (4/4), sonnet/low 3/4. => DEFAULT for substantive work (build, synthesis, verification, judgment) = opus/low; mechanical or precisely specified = sonnet; xhigh only for demanding agentic work.
- 5.5 effort (vendor): level names don't map 1:1 from 5.0. opus5.5 thinks more per turn at a level but needs fewer turns (its medium >= opus5 high). sonnet5.5 recalibrated: medium for agentic edits/multistep tools, low for reading/search/extraction (low may skip verifying). haiku5.5: 10x cheaper per token than haiku4.5 (~8x per text), unmeasured as a bulk reader => keeps one extraction over many items; sonnet stays the reader until measured.
- mechanics: `Agent` tool has no effort param (pin in agent frontmatter | Workflow call); effort is honored on every 5.5 agent incl. haiku; assistant cannot change the session model (`/model` user-only); usage chart = main sessions only (measured 2026-09-02) => delegated spend visible only in transcripts (tier-mirror.py).

CONSTRAINTS (hard):
- doubt a downgrade could hurt => do not downgrade. mechanical => downgrade without asking; upgrade only after saying so.
- session model + effort frozen at start; vary across sessions, never within one.
- pin every sub-agent (model + effort). rate-limited => retry THAT agent on another tier, never unpin globally. weak result | reply starts `ESCALATE:` => rerun one tier up.
- never `max` by default. fable5.1 = escalation only, low effort; unavailable (e.g. plan needs usage credits) => opus/max is the ceiling; never stall.
- fan-out >= 3 => announce one line first ("6 x sonnet/low"). give each agent the decision explicitly.

ORCHESTRATOR = the base: plans, decides, dispatches, judges, writes the final word; keeps plans/decisions in files (context = size of the task); locates material (grep, line ranges) but never reads bulk into its own context, edits at scale, or verifies raw sources itself.
- cheap reads, strong judges: sonnet (haiku for one extraction over many items) => digest {findings, quotes, paths}; opus/fable judges the digest, opens a source only on doubt. never bulk to a strong agent.
- each agent: gets paths + line ranges (not files); returns a bounded digest (not a dump); finishes in a few turns.
- one verifier per finding. add readers only on a named signal: sources disagree | load-bearing claim single-sourced | high-stakes conclusion.
- tool can prove it => no model (tests, builds, linters, exact checks run locally).

SESSION MODEL CHANGES ON ITS OWN (limits, fallback) => announce; pause judgment-heavy work; ask the user to restore; re-verify quality-critical decisions from that window.
```
