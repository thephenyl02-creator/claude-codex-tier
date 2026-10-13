#!/usr/bin/env python
"""tier-mirror: what the tiering rule actually did, read from the transcripts. Zero model tokens.

Usage:  python <skill dir>/scripts/tier-mirror.py [--day YYYY-MM-DD|today|yesterday] [--session PREFIX] [--json]

Default is today (local time). Reads every project under ~/.claude/projects: main sessions and
their sub-agents (nested transcript files). One row per API response. A response is stored as
several records (one per content block) whose usage accumulates, so the LAST record per message
id is taken. Dollar figures are the API list-price equivalent from the rule's price table, for
relative comparison only; how the subscription weights usage is not public.
"""
import argparse
import collections
import datetime
import glob
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.join(os.path.expanduser("~"), ".claude", "projects")
PRICE = {  # in, out, cache write, cache read ($ per MTok, list)
    # cache write = 2x input on the 1-hour cache this setup uses (1.25x is the 5-minute rate)
    "claude-fable-5-1": (10, 50, 20, 0.25),
    "claude-opus-5-5": (4, 20, 8, 0.2),
    "claude-sonnet-5-5": (2, 10, 4, 0.2),
    "claude-haiku-5-5": (0.1, 0.5, 0.2, 0.01),
    "claude-haiku-5-5 (>100K)": (0.5, 2.5, 1.0, 0.05),  # second rate card, prompt > 100K tokens
    "claude-fable-5": (10, 50, 20, 1.0),
    "claude-opus-5": (5, 25, 10, 0.5),
    "claude-sonnet-5": (2, 10, 4, 0.2),
    "claude-haiku-4-5-20251001": (1, 5, 2, 0.1),
    "claude-haiku-4-5": (1, 5, 2, 0.1),
}
# models priced by prompt length: a response whose prompt (in + cache write + cache read) exceeds
# 100K tokens is billed on the second rate card, so it is counted under its own key
LONG_PROMPT = {"claude-haiku-5-5": "claude-haiku-5-5 (>100K)"}
READ_TOOLS = {"Read", "Grep", "Glob", "WebFetch", "WebSearch", "ToolSearch"}
BASH_READ = ("cat ", "sed -n", "grep", "head ", "tail ", "ls ", "git show", "git diff", "git log", "find ", "wc ", "rg ", "python -c")


def cost(model, c):
    p = PRICE.get(model)
    if not p:
        return None
    return (c["in"] * p[0] + c["out"] * p[1] + c["cw"] * p[2] + c["cr"] * p[3]) / 1e6


def parse_ts(s):
    try:
        return datetime.datetime.fromisoformat((s or "").replace("Z", "+00:00"))
    except Exception:
        return None


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def scan(day=None, session=None):
    out = []
    for f in glob.glob(os.path.join(ROOT, "*", "**", "*.jsonl"), recursive=True):
        rel = os.path.relpath(f, ROOT).replace("\\", "/")
        parts = rel.split("/")
        who = "main" if len(parts) == 2 else "sub"
        sess = parts[1].replace(".jsonl", "")
        if session and not sess.startswith(session):
            continue
        last = collections.OrderedDict()
        tools = collections.Counter()
        bash_read = 0
        prompt = ""
        try:
            fh = open(f, encoding="utf-8", errors="replace")
        except Exception:
            continue
        with fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                msg = rec.get("message") if isinstance(rec.get("message"), dict) else None
                if not msg:
                    continue
                if rec.get("type") == "user" and who == "sub" and not prompt:
                    prompt = " ".join(text_of(msg.get("content")).split())[:90]
                if rec.get("type") != "assistant" or msg.get("model") in (None, "<synthetic>"):
                    continue
                ts = parse_ts(rec.get("timestamp"))
                if not ts:
                    continue
                if day and ts.astimezone().date().isoformat() != day:
                    continue
                u = msg.get("usage") or {}
                key = msg.get("id") or rec.get("uuid")
                model = msg.get("model")
                prompt_tokens = (u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
                                 + u.get("cache_read_input_tokens", 0))
                if model in LONG_PROMPT and prompt_tokens > 100_000:
                    model = LONG_PROMPT[model]
                last[key] = {
                    "model": model, "ts": ts,
                    "in": u.get("input_tokens", 0), "out": u.get("output_tokens", 0),
                    "cw": u.get("cache_creation_input_tokens", 0), "cr": u.get("cache_read_input_tokens", 0),
                }
                for b in msg.get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        name = b.get("name", "")
                        tools[name] += 1
                        if name == "Bash":
                            cmd = str((b.get("input") or {}).get("command", ""))[:200]
                            if any(k in cmd for k in BASH_READ):
                                bash_read += 1
        if not last:
            continue
        out.append({"project": parts[0], "session": sess, "who": who, "responses": list(last.values()),
                    "tools": tools, "bash_read": bash_read, "prompt": prompt})
    return out


def rebuilds(responses):
    """Full-context rebuilds (cache write >= 80K) in a main session, with the cause."""
    res = collections.Counter()
    tok = collections.Counter()
    prev_model = None
    prev_t = None
    for r in sorted(responses, key=lambda r: r["ts"]):
        if r["cw"] >= 80000:
            gap = (r["ts"] - prev_t).total_seconds() / 60 if prev_t else None
            if prev_model and r["model"] != prev_model:
                cause = "model switch"
            elif gap is None or gap > 60:
                cause = "idle > 60 min"
            else:
                cause = "prefix changed"
            res[cause] += 1
            tok[cause] += r["cw"]
        prev_model = r["model"]
        prev_t = r["ts"]
    return res, tok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--day")
    ap.add_argument("--session")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    day = a.day or (None if a.session else "today")
    if day == "today":
        day = datetime.date.today().isoformat()
    elif day == "yesterday":
        day = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
    data = scan(day, a.session)

    by = collections.defaultdict(collections.Counter)
    agents = []
    mains = []
    for s in data:
        c = collections.Counter()
        models = collections.Counter()
        for r in s["responses"]:
            models[r["model"]] += 1
            for k in ("in", "out", "cw", "cr"):
                by[(s["who"], r["model"])][k] += r[k]
                c[k] += r[k]
            by[(s["who"], r["model"])]["n"] += 1
            c["n"] += 1
        model = models.most_common(1)[0][0]
        reads = sum(v for k, v in s["tools"].items() if k in READ_TOOLS) + s["bash_read"]
        ncalls = sum(s["tools"].values())
        row = {"project": s["project"][:26], "session": s["session"][:8], "model": (model or "?").replace("claude-", ""),
               "responses": c["n"], "out": c["out"], "cw": c["cw"], "cr": c["cr"],
               "ctx_per_turn": c["cr"] // max(c["n"], 1), "read_share": (reads / ncalls) if ncalls else None,
               "cost": cost(model, c), "prompt": s["prompt"]}
        if s["who"] == "main":
            rb, rt = rebuilds(s["responses"])
            row["rebuilds"] = dict(rb)
            row["rebuild_tokens"] = sum(rt.values())
            mains.append(row)
        else:
            agents.append(row)

    total = collections.Counter()
    split = collections.Counter()
    total_cost = 0.0
    sub_cost = 0.0
    for (who, m), c in by.items():
        cs = cost(m, c) or 0.0
        total_cost += cs
        if who == "sub":
            sub_cost += cs
        for k in ("n", "out", "cw", "cr"):
            total[k] += c[k]
        p = PRICE.get(m)
        if p:
            split["out"] += c["out"] * p[1] / 1e6
            split["cw"] += c["cw"] * p[2] / 1e6
            split["cr"] += c["cr"] * p[3] / 1e6
    strong = [r for r in agents if "opus" in r["model"] or "fable" in r["model"]]
    strong_reads = [r["read_share"] for r in strong if r["read_share"] is not None]
    verdict = {
        "scope": f"day {day}" if day else f"session {a.session}",
        "responses": total["n"], "output_tokens": total["out"], "cache_write": total["cw"], "cache_read": total["cr"],
        "list_cost": round(total_cost, 2), "cost_split": {k: round(v, 2) for k, v in split.items()},
        "delegated_share_of_cost": round(sub_cost / total_cost, 3) if total_cost else None,
        "agents": len(agents), "strong_agents": len(strong),
        "strong_agent_read_share": round(sum(strong_reads) / len(strong_reads), 3) if strong_reads else None,
        "strong_agent_avg_ctx": (sum(r["cr"] for r in strong) // max(sum(r["responses"] for r in strong), 1)) if strong else None,
        "main_rebuild_tokens": sum(r["rebuild_tokens"] for r in mains),
        "main_rebuilds": dict(sum((collections.Counter(r["rebuilds"]) for r in mains), collections.Counter())),
    }
    if a.json:
        print(json.dumps({"verdict": verdict, "by_model": {f"{who}/{m}": dict(c) for (who, m), c in by.items()},
                          "main_sessions": mains, "agents": agents}, indent=1, default=str))
        return

    print(f"tier-mirror  {verdict['scope']}   (one row per API response; $ = list-price equivalent, relative use only)\n")
    print(f"{'who':5} {'model':26} {'responses':>9} {'output':>9} {'cache_w':>10} {'cache_r':>12} {'list$':>7}")
    for (who, m), c in sorted(by.items(), key=lambda x: (x[0][0], -(cost(x[0][1], x[1]) or 0))):
        cs = cost(m, c)
        print(f"{who:5} {m:26} {c['n']:9d} {c['out']:9d} {c['cw']:10d} {c['cr']:12d} {('%.0f' % cs) if cs is not None else '?':>7}")
    print(f"{'ALL':5} {'':26} {total['n']:9d} {total['out']:9d} {total['cw']:10d} {total['cr']:12d} {total_cost:7.0f}"
          f"   split: out {split['out']:.0f} / writes {split['cw']:.0f} / reads {split['cr']:.0f}")
    print("\nmain sessions (context per turn = what every tool call re-reads):")
    for r in sorted(mains, key=lambda r: -r["cr"]):
        print(f"  {r['project']:26} {r['session']} {r['model']:12} resp {r['responses']:4d} out {r['out']:8d} "
              f"ctx/turn {r['ctx_per_turn']:8d} rebuilds {r['rebuild_tokens']:>10,} {r['rebuilds']}")
    print(f"\nagents: {len(agents)} total, {len(strong)} on Opus/Fable; strong-agent read share "
          f"{verdict['strong_agent_read_share']}, avg context/turn {verdict['strong_agent_avg_ctx']}")
    print("  heaviest 10 by cache reads:")
    for r in sorted(agents, key=lambda r: -r["cr"])[:10]:
        rs = f"{r['read_share']:.0%}" if r["read_share"] is not None else "-"
        print(f"   {r['model']:10} resp {r['responses']:4d} ctx/turn {r['ctx_per_turn']:7d} reads {rs:>4} "
              f"${(r['cost'] or 0):5.1f}  {r['project']:22} {r['prompt'][:60]}")
    print(f"\nverdict: delegated share of cost {verdict['delegated_share_of_cost']}, strong agents read "
          f"{verdict['strong_agent_read_share']} of their tool calls, rebuilds {verdict['main_rebuild_tokens']:,} tokens {verdict['main_rebuilds']}")
    print("reading it: lower strong-agent read share and ctx/turn = strong agents judging digests instead of "
          "reading bulk; rebuilds should come only from sessions resumed after an hour.")


if __name__ == "__main__":
    main()
