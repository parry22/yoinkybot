#!/usr/bin/env python3
"""
keyword_cluster.py — turn a flat keyword list into a pillar/cluster topical map.

    python keyword_cluster.py keywords.csv --volume-col "Search Volume" --min-cluster 3
    python keyword_cluster.py keywords.txt --seed "email marketing"
    python semrush.py related "email marketing" --limit 300 --csv kw.csv \
        && python keyword_cluster.py kw.csv

Accepts a CSV (auto-detects a keyword column and an optional volume column) or a
plain text file with one keyword per line. Standard library only.

Method: lexical clustering on modifier n-grams. Keywords are stripped of the
seed/head terms and stopwords, then grouped by their most distinctive shared
token. This is deliberately simple and transparent — it is a planning aid, not a
substitute for looking at the actual SERPs.

The real test of whether two keywords belong on one page is whether the search
results for them overlap. If the top 10 are largely the same pages, they are one
page. If they differ, they are two. Verify the groupings this produces against
that test before committing to a content plan.
"""

import argparse
import csv
import json
import re
import sys
from collections import Counter, defaultdict

STOP = {
    "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with", "at",
    "by", "from", "is", "are", "be", "it", "this", "that", "your", "you", "my",
    "i", "we", "our", "s", "t", "vs", "&",
}

# Question words and generic qualifiers make terrible cluster names — a "how"
# cluster tells you nothing. They stay in the keywords (and drive H2 selection)
# but are never chosen as the token that defines a cluster.
NOT_A_CLUSTER = {
    "what", "why", "how", "when", "where", "who", "which", "does", "do", "can",
    "should", "will", "good", "bad", "best", "top", "free", "cheap", "easy",
    "guide", "tips", "ideas", "examples", "example", "list", "vs", "versus",
    "using", "use", "get", "make", "set", "up", "about", "into", "out", "not",
}

INTENT_PATTERNS = [
    ("transactional", r"\b(buy|price|pricing|cost|cheap|discount|coupon|deal|order|subscribe|hire|trial)\b"),
    ("commercial",    r"\b(best|top|review|reviews|compare|comparison|vs|versus|alternative|alternatives|software|tool|tools|platform|service)\b"),
    ("informational", r"\b(what|why|how|when|where|who|guide|tutorial|examples?|meaning|definition|tips|ideas|checklist|template)\b"),
    ("navigational",  r"\b(login|sign in|download|app|dashboard|pricing page|contact)\b"),
]

QUESTION_STARTS = ("what", "why", "how", "when", "where", "who", "which",
                   "is", "are", "can", "should", "does", "do", "will")


def classify_intent(kw):
    for label, pattern in INTENT_PATTERNS:
        if re.search(pattern, kw, re.I):
            return label
    return "informational"


def load(path, kw_col=None, vol_col=None):
    """Return [(keyword, volume|None), ...]."""
    raw = open(path, encoding="utf-8-sig").read()
    if not raw.strip():
        sys.exit(f"{path} is empty.")

    first = raw.splitlines()[0]
    delim = ";" if first.count(";") > first.count(",") else ","
    looks_csv = path.lower().endswith((".csv", ".tsv")) or delim in first

    if not looks_csv:
        return [(l.strip(), None) for l in raw.splitlines() if l.strip()]

    rows = list(csv.DictReader(raw.splitlines(), delimiter=delim))
    if not rows:
        sys.exit("No rows parsed. Check the delimiter and header row.")

    headers = [h for h in rows[0].keys() if h]

    def find(cands, given):
        if given:
            if given not in headers:
                sys.exit(f"Column '{given}' not found. Available: {headers}")
            return given
        for h in headers:
            if h.strip().lower() in cands:
                return h
        return None

    kcol = find({"keyword", "keywords", "phrase", "query", "term"}, kw_col)
    vcol = find({"search volume", "volume", "nq", "searches", "monthly searches"}, vol_col)

    if not kcol:
        kcol = headers[0]
        print(f"[note] No keyword column detected; using '{kcol}'.", file=sys.stderr)

    out = []
    for r in rows:
        k = (r.get(kcol) or "").strip()
        if not k:
            continue
        v = None
        if vcol:
            raw_v = re.sub(r"[^\d]", "", str(r.get(vcol) or ""))
            v = int(raw_v) if raw_v else None
        out.append((k, v))
    return out


def tokens(kw):
    return [t for t in re.findall(r"[a-z0-9']+", kw.lower()) if t not in STOP and len(t) > 1]


def head_terms(keywords, top=3):
    """The tokens present in most keywords — the topic's 'head', not a differentiator."""
    counts = Counter()
    for k in keywords:
        counts.update(set(tokens(k)))
    n = len(keywords)
    return {t for t, c in counts.items() if c >= n * 0.55}


def cluster(pairs, seed=None, min_size=2):
    keywords = [k for k, _ in pairs]
    vols = {k: v for k, v in pairs}

    head = head_terms(keywords)
    if seed:
        head |= set(tokens(seed))

    # score each candidate modifier token by how many keywords contain it
    freq = Counter()
    for k in keywords:
        freq.update({t for t in tokens(k) if t not in head and t not in NOT_A_CLUSTER})

    assigned = {}
    groups = defaultdict(list)

    # assign each keyword to its rarest-but-shared modifier, so clusters stay
    # specific rather than collapsing into one giant bucket
    for k in keywords:
        cands = [t for t in tokens(k)
                 if t not in head and t not in NOT_A_CLUSTER and freq[t] >= min_size]
        if cands:
            # prefer the token that groups the fewest keywords (most specific)
            best = min(cands, key=lambda t: (freq[t], -len(t)))
            groups[best].append(k)
            assigned[k] = best

    orphans = [k for k in keywords if k not in assigned]

    # merge tiny clusters into orphans
    for name in [n for n, ks in groups.items() if len(ks) < min_size]:
        orphans.extend(groups.pop(name))

    def vol(ks):
        vs = [vols[k] for k in ks if vols.get(k)]
        return sum(vs) if vs else None

    out = []
    for name, ks in groups.items():
        ks = sorted(set(ks), key=lambda k: (-(vols.get(k) or 0), k))
        out.append({
            "cluster": name,
            "size": len(ks),
            "total_volume": vol(ks),
            "intent": Counter(classify_intent(k) for k in ks).most_common(1)[0][0],
            "questions": [k for k in ks if k.lower().split()[0] in QUESTION_STARTS],
            "suggested_title": suggest_title(name, ks),
            "keywords": ks,
        })

    out.sort(key=lambda c: (-(c["total_volume"] or 0), -c["size"]))
    return out, sorted(set(orphans)), sorted(head)


def suggest_title(name, keywords):
    """Propose an H1 for the cluster page from its highest-signal keyword."""
    q = [k for k in keywords if k.lower().split()[0] in QUESTION_STARTS]
    base = q[0] if q else keywords[0]
    return base[0].upper() + base[1:]


def report(clusters, orphans, head, seed, pillar_words=(3000, 5000)):
    print("\nTOPICAL MAP")
    print("=" * 72)
    if seed:
        print(f"Seed: {seed}")
    print(f"Head terms (shared across the territory, not differentiators): {', '.join(head) or '—'}")
    total_kw = sum(c["size"] for c in clusters) + len(orphans)
    total_vol = sum(c["total_volume"] or 0 for c in clusters)
    print(f"{len(clusters)} clusters · {total_kw} keywords · "
          f"{total_vol:,} combined monthly volume" if total_vol else
          f"{len(clusters)} clusters · {total_kw} keywords")
    print("=" * 72)

    print(f"\nPILLAR PAGE  ({pillar_words[0]:,}-{pillar_words[1]:,} words)")
    print(f"  Target: {seed or 'the head term for this territory'}")
    print(f"  Job: cover the whole subject at a high level and link to every cluster page below.")

    for i, c in enumerate(clusters, 1):
        vol = f"{c['total_volume']:,}/mo" if c["total_volume"] else "volume n/a"
        print(f"\n{i}. CLUSTER: {c['cluster']}   [{c['size']} kw · {vol} · {c['intent']}]")
        print(f"   Suggested H1: {c['suggested_title']}")
        for k in c["keywords"][:10]:
            print(f"     - {k}")
        if c["size"] > 10:
            print(f"     ... and {c['size'] - 10} more")
        if c["questions"]:
            print(f"   H2 candidates (question form — high GEO value):")
            for q in c["questions"][:4]:
                print(f"     - {q[0].upper() + q[1:]}?" if not q.endswith("?") else f"     - {q}")

    if orphans:
        print(f"\nUNCLUSTERED ({len(orphans)})")
        print("  Too specific or too isolated to group. Fold into the nearest cluster page")
        print("  as an H2, or drop them.")
        for k in orphans[:20]:
            print(f"    - {k}")
        if len(orphans) > 20:
            print(f"    ... and {len(orphans) - 20} more")

    print("\n" + "-" * 72)
    print("NEXT STEPS")
    print("  1. Verify: search 2-3 keywords from each cluster. If the top 10 results")
    print("     overlap heavily, they belong on ONE page. If not, split the cluster.")
    print("  2. Merge any cluster under ~3 keywords into a neighbour.")
    print("  3. Order by intent value, not volume — commercial clusters first if the")
    print("     goal is revenue, informational first if the goal is authority.")
    print("  4. Write the pillar last. It's easier once the clusters exist.")


def main():
    p = argparse.ArgumentParser(description="Cluster keywords into a pillar/cluster topical map.")
    p.add_argument("file", help="CSV or newline-delimited keyword file")
    p.add_argument("--seed", help="the head term for this territory (improves clustering)")
    p.add_argument("--keyword-col", help="CSV column containing keywords")
    p.add_argument("--volume-col", help="CSV column containing search volume")
    p.add_argument("--min-cluster", type=int, default=2, help="minimum keywords per cluster (default 2)")
    p.add_argument("--json", action="store_true", help="emit JSON")
    args = p.parse_args()

    pairs = load(args.file, args.keyword_col, args.volume_col)
    if not pairs:
        sys.exit("No keywords found.")

    clusters, orphans, head = cluster(pairs, args.seed, args.min_cluster)

    if args.json:
        print(json.dumps({"seed": args.seed, "head_terms": head,
                          "clusters": clusters, "unclustered": orphans}, indent=2))
    else:
        report(clusters, orphans, head, args.seed)


if __name__ == "__main__":
    main()
