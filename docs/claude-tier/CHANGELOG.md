# Claude Tier changelog

Each entry is an installable GitHub release of the `tier` plugin. Development between releases lives in the commit log. The rule block tag (`tier-rule vX.Y.Z`) and the release version are independent: a docs-only release does not bump the tag.

- **1.11.1** - The 5.5 re-measure, four stale facts, and honest prices.
  The routes are now measured on the 5.5 models: 429 graded runs, 3 models
  x 5 efforts on a tool-checked build, a silent bug hunt with decoys and a
  silent synthesis with traps, at least 5 runs per setting. Opus was perfect
  at every effort; Sonnet missed once each at low and medium on the bug
  hunt and was clean from high; Haiku at low passed the tool-checked build
  59/59 but missed on silent work (bug hunt 57/59, synthesis 4/10), and
  Haiku at medium was 15/15 (23/24 counting an easier synthesis). So the defaults become: tool-checked work to
  Haiku at low, reviewable cited extraction to Haiku at medium (inferred, not yet
  measured on cited extraction), silent work
  fully determined by its input to Sonnet at high, judgment and ambiguity
  to Opus at low - and a new hard constraint puts Haiku only where its
  mistakes get seen. Effort cost against low on Sonnet and Opus: high 1.0-1.6x,
  xhigh 1.1-2x, max 2-9x, with no quality gain unless the model was at its limit.
  An earlier cost script counted each reply once per content block and
  roughly doubled every figure (more at high effort); the numbers above are
  corrected and were re-derived by two independent checks. Four runtime
  facts in 1.11.0 had gone stale and are fixed: an effort change keeps the
  cache on the 5.5 models and Fable 5.1; the `Agent` tool takes an effort
  per call, and per-call model and effort override an agent file;
  `CLAUDE_CODE_SUBAGENT_MODEL` sets the default for unpinned sub-agents;
  `/usage` shows the sub-agent share. Fable's "low effort" qualifier is
  dropped (on 5.0, Fable at low missed an ambiguous build that Fable at
  high passed; the adjudicator runs at high). Boot re-measured: ~10K tokens with
  a listed toolset against ~55K with every tool. `tier-mirror.py` now prices
  cache writes from the usage's TTL split (sub-agents write at the 5-minute
  rate, 1.25x input, not 2x) and keeps the largest output count per reply:
  2026-10-23 drops from $58.51 to $51.23. Block tag `tier-rule v1.11.1`;
  `/tier` upgrades older installs in place.
- **1.11.0** - The 5.5 models, and a rule written for the model to read.
  Prices and pins move to the current generation: Opus 5.5 ($4/$20, cache
  reads $0.20 - 20% below Opus 5, 60% below on reads), Sonnet 5.5 (same
  price as Sonnet 5) and Haiku 5.5 ($0.10/$0.50 up to a 100K-token prompt,
  five times that above it - 10x below Haiku 4.5 per token, about 8x for
  the same text since its tokenizer counts ~30% more). Fable 5.1 stays the
  escalation. Checked in Claude Code on 2026-10-12: the `opus`, `sonnet` and
  `haiku` aliases resolve to the 5.5 models and `fable` to 5.1, so the
  reference agents keep their aliases; effort is now honored on Haiku
  sub-agents; and a sub-agent with a listed toolset boots at ~9K tokens on
  all three 5.5 models, retiring the old ~44K Opus figure. Sonnet 5.5's
  effort levels are recalibrated, so the executor moves from low to medium -
  the vendor's starting point for agentic edits, and the quality-first
  choice under doubt. The quality findings were measured on the 5.0
  generation and the rule now says so; nothing was re-run on 5.5, and Haiku
  5.5 keeps its role until it is measured as a reader. The rule itself is
  rewritten from a prose routing table into terse facts and hard
  constraints (~1,060 tokens) from which the model derives each route. A
  three-day local trial of that form moved neither cost nor which models do
  the reading by a measurable amount - strong-agent context per turn fell
  about 40% on mid-size agents, unevenly across projects - so this release
  claims no efficiency gain for it. Also: the three strong reference agents
  gain the context-economy paragraph, `tier-mirror.py` (per-model spend
  from local transcripts, zero model tokens) ships in the plugin, and
  `/tier` matches its marker case-insensitively.

- **1.10.0** - The measured rule, audited. Four sweep rounds (125 graded
  agent runs over eight task shapes, every grader validated against a
  baseline and a reference first) settled model-versus-effort: **model is the
  strong lever, effort the weak one.** Opus at low held the one edge case
  Sonnet failed at low, medium and high; a 19-test hard build came back
  perfect from every cell, so a low pin degrades on ambiguity, not
  difficulty - hence the `ESCALATE:` hatch (a pinned-low agent that meets
  more than its brief hands the task back for a one-tier-up re-run). `max`
  is never a default: 2-5x the cost of low for no correctness gain. An
  independent adversarial read then found the headline verification claim
  ("Fable catches what Opus misses") rested on a grader flaw; re-measured
  fairly, Opus/low 4/4, Fable/low 4/4, Sonnet/low 3/4. The verification lane
  is retracted, Fable 5.1 is escalation-only with an honest cost line (list
  output 2x Opus, measured total 1-2x by task, no quality edge measured), and
  verification and integration pin to Opus/low - the integrator had paid
  2.7x for a tighter summary. Boot cost tracks the model and whether the
  agent takes `tools: *` (3x), not which built-ins it lists. A zero-token
  hook that rewrites unpinned `Agent` calls was built, proven and rejected
  as unnecessary at a 3% miss rate. Block tag `tier-rule v1.10.0`.
- **1.9.0** - Newest-in-tier, and Fable 5.1. The per-version deny list ("never
  Opus 4.6 or Sonnet 4.6") was a special case of a general rule the routing
  table now states once: **within a tier, always the newest model** - same or
  lower price, better model. Verified against the live pricing page: Opus 5,
  4.8, 4.7 and 4.6 are all $5/$25; Sonnet 5's $2/$10 (introductory pricing now
  made permanent) undercuts Sonnet 4.6's $3/$15; Fable 5.1 matches Fable 5's
  $10/$50 with **cache reads at a quarter of the price** and materially higher
  benchmarks. Fable 5.1 is therefore the Fable the rule means. Two practical
  facts ride along: the short alias `fable` still resolves to Fable 5, so pin
  by full model ID where an alias lags (agent frontmatter honors full IDs -
  verified at runtime); and because Fable 5.1's cache reads are half of Opus
  5's, long cache-bound sessions narrow the "2x Opus" gap the escalation rule
  assumes. Block tag `tier-rule v1.9.0`; `/tier` upgrades older installs in place.
- **1.8.1** - `/tier` is now aware of a user-level global rule. The skill only
  ever read PROJECT files, so a user carrying the rule in `~/.claude/CLAUDE.md`
  (which loads automatically in every session) who ran `/tier` in a project got
  a second ~900-token copy loading alongside the global on every turn - the
  skill's own author accumulated six stale project copies this way before
  noticing. New step 0 checks the user-level file first: already covered by a
  same-or-newer global in local mode -> stop and say so; global older than the
  skill -> offer to upgrade the GLOBAL in place (one copy, every project);
  `/tier repo` proceeds regardless, since committed-file coverage for web and
  mobile sessions is its whole point, noting that local sessions in that
  project will then load both copies. Rule content is unchanged - the block tag
  stays `tier-rule v1.8.0` and existing installs are untouched.
- **1.8.0** - The first release since 1.6.0, and the first whose every number
  was measured rather than reasoned about. 1.6.0 was not broken; it was simply
  built on assumptions nobody had tested. Everything in between was unreleased
  development - including several corrections that never reached anyone, which
  is why it collapses into this one entry rather than a run of them. The commit
  log carries that detail.

  **Measured, reproducible on any machine:**
  - Switching model OR effort mid-session drops `cache_read` to zero and costs
    **20x the identical turn** ($0.017 -> $0.346), with a control turn proving
    the cache returns once the setting holds. Both are start-of-session choices.
  - A cache WRITE costs ~20x a cache READ for the same tokens, so a thrashing
    session pays roughly **double list price** - not merely losing a discount.
  - A sub-agent pays a flat BOOT cost before doing any work: **~10K on Haiku,
    ~44K on Opus** (~$0.28). It scales with the MODEL, not the agent's `tools:`
    list - a controlled A/B differed by 0.6%. Small one-shot work is therefore
    cheaper INLINE however cheap the model.
  - An unpinned sub-agent really does inherit the session model - verified, and
    it burned 44,363 tokens to reply "OK".
  - A parallel fan-out shares the prefix the first agent cached: three agents
    dispatched together wrote **17.9K boot tokens against ~29.4K separately**.
  - Delegation overhead is not a constant. WITH a real tier drop it inverts -
    a bounded task cost **0.82x** delegated versus inline.
  - Haiku's effort dial works, with a narrow range: 1.7x low-to-max against
    Sonnet's 9.5x.

  **Also fixed:** the routing table no longer contradicts the boot floor; the
  rule states each condition in one sentence instead of a paragraph of
  evidence; and the README documents that pinning sub-agent effort needs
  `.claude/agents/*.md` files, which `/tier` does not create.

  **If you installed between 14 Aug and now, you had 1.6.0 regardless of what
  this repo said.** The plugin manifests pin a release asset by URL and
  sha256, and they had been left at 1.6.0, so the marketplace served that
  build no matter what landed on `main`. Fixed here, and the verification
  suite now fails if the published release and the pinned version ever
  diverge again.
- **1.6.0** - Butter-smooth install, clean repos. Two changes.
  **(1) One-command installers** for macOS/Linux (`install.sh`) and Windows
  (`install.ps1`) that absorb every blocker observed in the wild: missing
  Claude Code CLI (auto-installs it), `claude` not on PATH (uses the absolute
  path; persists PATH only when the shell profile is actually writable, with
  the `chown` fix printed when it isn't), and SSH-to-GitHub failures (forces
  HTTPS via env vars for the install only - your git config is never
  touched). If the plugin route still fails, the installer falls back to a
  direct no-git skill copy into `~/.claude/skills/`. The plugin itself now
  ships as a **sha256-pinned zip archive** (release asset), and the
  marketplace can be added straight from its manifest URL - so the native
  plugin flow works end-to-end with no git on the machine at all. README
  gains audience-based install paths (beginner one-liners per platform,
  two-command CLI path, git-free native path, desktop GUI, cloud
  `settings.json`) and a troubleshooting section.
  **(2) `/tier` no longer touches your repo by default.** The rule is a
  personal working preference, so it now lands in a machine-local
  `CLAUDE.local.md` kept untracked via `.git/info/exclude` (not even your
  `.gitignore` changes); previously it was written into the committed
  `CLAUDE.md`, pushing one person's preference onto every collaborator.
  `/tier repo` keeps the old behavior as an explicit opt-in for web + mobile
  coverage, and `/tier` offers to migrate pre-1.6 blocks out of committed
  `CLAUDE.md`. Block tag is now `tier-rule v1.6` (heading made
  location-neutral; rule content unchanged) - `/tier` auto-upgrades older
  installs in place.
- **1.5.0** - Corrects 1.4.0's reasoning and hardens the response. 1.4.0
  implied that keeping web content out of the frontier context would avoid
  mid-task model downgrades. **That was wrong** - a downgrade was later
  observed on a routine README edit with no web content involved. 1.5.0
  therefore states plainly that **downgrades are unpredictable and cannot be
  prevented**, keeps the delegate-bulk-content rule but justifies it purely
  as *routing* (it is Sonnet-tier work regardless), and turns the response
  into a numbered protocol ending in the step 1.4.0 missed: **after the model
  is restored, re-verify any quality-critical output produced during the
  downgrade window.** A silent tier loss is only harmless if nothing
  important was decided inside it.
- **1.4.0** - First attempt at guarding mid-task model downgrades: delegate
  web fetches to cheap sub-agents, announce downgrades, pause judgment work.
  Superseded by 1.5.0, whose rationale is correct.
- **1.3.0** - Anti-drift rules, learned from a long session where the routing
  silently decayed. Three additions: **pin every sub-agent** (an unpinned
  agent inherits the session model, so mechanical fan-out silently runs at
  frontier prices with no visible signal); a **capacity-error repair rule**
  (a rate-limited tier means retry that agent elsewhere, never strip pins
  globally - and restore them immediately if you do); and **state the routing
  before spending it** (any 3+ agent fan-out announces "6 x Sonnet/medium"
  first, so a mis-route is caught before the tokens, not after). Block tag is
  now `tier-rule v1.3`; `/tier` auto-upgrades older installs in place.
- **1.2.1** - `/tier` now handles non-repo directories (home folder, scratch
  space, unversioned code): it installs into the current directory's
  `CLAUDE.md` as a machine-local rule instead of skipping. Installed block
  unchanged (still `tier-rule v1.2`) - existing installs need nothing.
- **1.2.0** - Subscription-aware (plans without Fable treat Opus as the top
  tier automatically); Fable escalation triggers now cover its benchmarked
  strengths (high-stakes deep research, long-horizon software engineering,
  legal/compliance-critical and deep security analysis); canonical block
  rewritten model-first (compact, imperative, cheaper per session); versioned
  upgrade tag (`tier-rule v1.2`) so `/tier` upgrades reliably across future
  releases.
- **1.1.0** - Opus 5 era routing. Opus is now the default top tier (including
  reviews, synthesis, and final judgment); Fable becomes an explicit
  escalation with named triggers. New "routing is free" principle. `/tier`
  now auto-upgrades older installed blocks in place.
- **1.0.0** - Initial release.
