#!/usr/bin/env python3
"""
semrush.py — keyword research, competitor analysis, and difficulty checks
via the Semrush Analytics API (v3).

Setup:
    export SEMRUSH_API_KEY="your_key"     # find it in Semrush > Subscription info > API units

Never paste the key on the command line or into a chat window.

Endpoint: https://api.semrush.com/  (GET, returns semicolon-delimited CSV)

Units are metered and do NOT roll over between billing cycles. Most analytics
reports cost 10 units per RETURNED LINE (50 for historical), so display_limit is
the main cost lever. Always estimate before large pulls:

    python semrush.py cost related --limit 500

Subcommands
-----------
    overview     phrase_this        one keyword: volume, CPC, competition, results
    related      phrase_related     semantically related keywords
    questions    phrase_questions   question-form keywords (highest GEO value)
    broad        phrase_fullsearch  broad-match keyword universe
    difficulty   phrase_kdi         keyword difficulty for one or more keywords
    domain       domain_organic     keywords a domain ranks for
    url          url_organic        keywords a specific URL ranks for
    competitors  domain_organic_organic   organic competitors of a domain
    gap          domain_domains     keywords competitors rank for that you don't
    balance      —                  remaining API units
    cost         —                  estimate unit cost, no API call

Common flags
------------
    --db us            regional database (us, uk, in, ca, au, de, fr, ...)
    --limit N          max rows (THE cost lever; default 25)
    --min-volume N     filter: monthly search volume >= N
    --max-kd N         filter: keyword difficulty <= N
    --max-competition  filter: paid competition <= 0-1 float
    --json             emit JSON instead of a table
    --csv PATH         also write raw rows to a CSV file
    --dry-run          print the request and estimated cost, make no call
"""

import argparse
import csv
import json
import os
import sys
import urllib.parse
import urllib.request
import urllib.error

API_ROOT = "https://api.semrush.com/"
TIMEOUT = 60

# Column code -> human label. Semrush returns its own headers, but these are
# used for filtering, sorting, and explaining output.
COLUMNS = {
    "Ph": "keyword",
    "Nq": "volume",
    "Cp": "cpc",
    "Co": "competition",
    "Nr": "results",
    "Kd": "difficulty",
    "Td": "trend",
    "In": "intent",
    "Rr": "relevance",
    "Fk": "features",
    "Po": "position",
    "Pp": "prev_position",
    "Ur": "url",
    "Tr": "traffic_pct",
    "Tc": "traffic_cost_pct",
    "Dn": "domain",
    "Cr": "competitor_level",
    "Or": "organic_keywords",
    "Ot": "organic_traffic",
    "Oc": "organic_cost",
    "P0": "pos_target",
    "P1": "pos_comp1",
    "P2": "pos_comp2",
    "P3": "pos_comp3",
}

# report type -> (default export columns, units per returned line)
REPORTS = {
    "phrase_this":            ("Ph,Nq,Cp,Co,Nr,Td,In,Kd", 10),
    "phrase_related":         ("Ph,Nq,Cp,Co,Nr,Td,Rr,Kd,In", 10),
    "phrase_questions":       ("Ph,Nq,Cp,Co,Nr,Td,Kd,In", 10),
    "phrase_fullsearch":      ("Ph,Nq,Cp,Co,Nr,Td,Kd,In", 10),
    "phrase_kdi":             ("Ph,Kd", 10),
    "domain_organic":         ("Ph,Po,Nq,Cp,Co,Tr,Tc,Kd,Ur,In", 10),
    "url_organic":            ("Ph,Po,Nq,Cp,Co,Tr,Tc,Nr,Td", 10),
    "domain_organic_organic": ("Dn,Cr,Np,Or,Ot,Oc,Ad", 40),
    "domain_domains":         ("Ph,P0,P1,P2,P3,Nq,Kd,Co,Cp", 20),
}

INTENT_LABELS = {"0": "commercial", "1": "informational",
                 "2": "navigational", "3": "transactional"}


# --------------------------------------------------------------------------
# request layer
# --------------------------------------------------------------------------

def api_key():
    key = os.environ.get("SEMRUSH_API_KEY", "").strip()
    if not key:
        sys.exit(
            "SEMRUSH_API_KEY is not set.\n"
            "  export SEMRUSH_API_KEY='your_key'\n"
            "Find it in Semrush > Subscription info > API units.\n"
            "If you don't have a key, see references/keyword-research.md "
            "for the no-tools research workflow."
        )
    return key


def build_filter(min_volume=None, max_kd=None, max_competition=None,
                 min_kd=None, exclude=None):
    """Semrush display_filter syntax: +|Field|Op|Value joined by |.

    Ops: Gt (greater than), Lt (less than), Eq, Co (contains), Bw, Ew.
    A leading + includes, - excludes.
    """
    parts = []
    if min_volume is not None:
        parts.append(f"+|Nq|Gt|{min_volume}")
    if max_kd is not None:
        parts.append(f"+|Kd|Lt|{max_kd}")
    if min_kd is not None:
        parts.append(f"+|Kd|Gt|{min_kd}")
    if max_competition is not None:
        parts.append(f"+|Co|Lt|{max_competition}")
    for term in (exclude or []):
        parts.append(f"-|Ph|Co|{term}")
    return "|".join(parts) if parts else None


def request(params, dry_run=False):
    """Call the API and return a list of dict rows."""
    params = {k: v for k, v in params.items() if v not in (None, "")}
    params.setdefault("key", api_key())
    url = API_ROOT + "?" + urllib.parse.urlencode(params, safe="|*+/:")

    if dry_run:
        safe = url.replace(params["key"], "<KEY>")
        print(f"GET {safe}")
        rows = int(params.get("display_limit", 1))
        units, dollars = estimate(params.get("type", ""), rows)
        print(f"\nDry run — no call made. Worst case {rows} rows "
              f"= {units:,} units (~${dollars:,.2f}). "
              f"You are only charged for rows returned.")
        sys.exit(0)

    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as r:
            body = r.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:400]
        sys.exit(f"HTTP {e.code} from Semrush: {detail}")
    except urllib.error.URLError as e:
        sys.exit(f"Network error reaching Semrush: {e.reason}")

    body = body.strip()
    if not body:
        return []

    # Semrush signals errors as a plain line, e.g. "ERROR 50 :: NOTHING FOUND"
    if body.upper().startswith("ERROR"):
        if "NOTHING FOUND" in body.upper():
            return []
        sys.exit(f"Semrush error: {body}")

    reader = csv.DictReader(body.splitlines(), delimiter=";")
    return [dict(row) for row in reader]


# --------------------------------------------------------------------------
# output layer
# --------------------------------------------------------------------------

def normalize(rows):
    """Tidy values: numeric coercion, intent decoding, whitespace."""
    out = []
    for row in rows:
        clean = {}
        for k, v in row.items():
            if k is None:
                continue
            k = k.strip()
            v = (v or "").strip()
            if k in ("Search Volume", "Number of Results", "Organic Keywords",
                     "Organic Traffic", "Common Keywords"):
                v = int(v) if v.isdigit() else v
            elif k in ("CPC", "Competition", "Keyword Difficulty Index",
                       "Competition Level", "Traffic (%)"):
                try:
                    v = float(v)
                except ValueError:
                    pass
            elif k == "Intent":
                v = "/".join(INTENT_LABELS.get(p, p) for p in v.split(","))
            clean[k] = v
        out.append(clean)
    return out


def table(rows, limit=None):
    if not rows:
        print("No results. Try a broader seed, a different --db, or looser filters.")
        return
    rows = rows[:limit] if limit else rows
    headers = list(rows[0].keys())
    widths = {h: max(len(h), *(len(str(r.get(h, ""))) for r in rows)) for h in headers}
    widths = {h: min(w, 46) for h, w in widths.items()}

    def fmt(vals):
        return "  ".join(str(v)[:widths[h]].ljust(widths[h]) for h, v in zip(headers, vals))

    print(fmt(headers))
    print("  ".join("-" * widths[h] for h in headers))
    for r in rows:
        print(fmt([r.get(h, "") for h in headers]))
    print(f"\n{len(rows)} rows")


def emit(rows, args):
    rows = normalize(rows)
    if args.csv and rows:
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        print(f"Wrote {len(rows)} rows to {args.csv}", file=sys.stderr)
    if args.json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
    else:
        table(rows)
    return rows


def estimate(report, limit):
    per_line = REPORTS.get(report, (None, 10))[1]
    units = per_line * limit
    return units, units * 0.00005  # ~$0.00005/unit at list pricing


# --------------------------------------------------------------------------
# subcommands
# --------------------------------------------------------------------------

def cmd_overview(args):
    rows = request({
        "type": "phrase_this",
        "phrase": args.keyword,
        "database": args.db,
        "export_columns": REPORTS["phrase_this"][0],
    }, args.dry_run)
    emit(rows, args)


def _phrase_report(args, report, sort="nq_desc"):
    params = {
        "type": report,
        "phrase": args.keyword,
        "database": args.db,
        "export_columns": REPORTS[report][0],
        "display_limit": args.limit,
        "display_sort": sort,
    }
    flt = build_filter(args.min_volume, args.max_kd,
                       args.max_competition, args.min_kd, args.exclude)
    if flt:
        params["display_filter"] = flt
    rows = request(params, args.dry_run)
    emit(rows, args)


def cmd_related(args):
    _phrase_report(args, "phrase_related")


def cmd_questions(args):
    _phrase_report(args, "phrase_questions")


def cmd_broad(args):
    _phrase_report(args, "phrase_fullsearch")


def cmd_difficulty(args):
    rows = request({
        "type": "phrase_kdi",
        "phrase": ";".join(args.keywords),
        "database": args.db,
        "export_columns": REPORTS["phrase_kdi"][0],
    }, args.dry_run)
    emit(rows, args)


def cmd_domain(args):
    params = {
        "type": "domain_organic",
        "domain": args.domain,
        "database": args.db,
        "export_columns": REPORTS["domain_organic"][0],
        "display_limit": args.limit,
        "display_sort": "tr_desc",
    }
    flt = build_filter(args.min_volume, args.max_kd,
                       args.max_competition, args.min_kd, args.exclude)
    if flt:
        params["display_filter"] = flt
    emit(request(params, args.dry_run), args)


def cmd_url(args):
    emit(request({
        "type": "url_organic",
        "url": args.url,
        "database": args.db,
        "export_columns": REPORTS["url_organic"][0],
        "display_limit": args.limit,
        "display_sort": "tr_desc",
    }, args.dry_run), args)


def cmd_competitors(args):
    emit(request({
        "type": "domain_organic_organic",
        "domain": args.domain,
        "database": args.db,
        "export_columns": REPORTS["domain_organic_organic"][0],
        "display_limit": args.limit,
    }, args.dry_run), args)


def cmd_gap(args):
    """Keywords competitors rank for that the target domain does not.

    domains syntax: <sign>|<type>|<domain> joined by |
      *  = must rank      +  = may rank      -  = must NOT rank
    So: competitors get * and +, your own domain gets -.
    """
    comps = args.competitors
    spec = [f"*|or|{comps[0]}"]
    spec += [f"+|or|{c}" for c in comps[1:]]
    spec.append(f"-|or|{args.domain}")

    params = {
        "type": "domain_domains",
        "domains": "|".join(spec),
        "database": args.db,
        "export_columns": REPORTS["domain_domains"][0],
        "display_limit": args.limit,
        "display_sort": "nq_desc",
    }
    flt = build_filter(args.min_volume, args.max_kd,
                       args.max_competition, args.min_kd, args.exclude)
    if flt:
        params["display_filter"] = flt
    emit(request(params, args.dry_run), args)


def cmd_balance(args):
    key = api_key()
    url = f"https://www.semrush.com/users/countapiunits.html?key={key}"
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as r:
            print(f"API units remaining: {r.read().decode().strip()}")
    except Exception as e:
        sys.exit(f"Could not read balance: {e}")


def cmd_cost(args):
    report_map = {
        "overview": "phrase_this", "related": "phrase_related",
        "questions": "phrase_questions", "broad": "phrase_fullsearch",
        "difficulty": "phrase_kdi", "domain": "domain_organic",
        "url": "url_organic", "competitors": "domain_organic_organic",
        "gap": "domain_domains",
    }
    report = report_map.get(args.report, args.report)
    units, dollars = estimate(report, args.limit)
    per_line = REPORTS.get(report, (None, 10))[1]
    print(f"report      : {report}")
    print(f"rows        : {args.limit}")
    print(f"units/row   : {per_line}")
    print(f"total units : {units:,}")
    print(f"approx cost : ${dollars:,.2f}  (list pricing; your rate may differ)")
    print("\nNote: units are only charged for rows actually returned, and "
          "empty responses cost nothing.")


# --------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(
        prog="semrush.py",
        description="Semrush Analytics API v3 helper for keyword and competitor research.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Subcommands")[1] if "Subcommands" in __doc__ else None,
    )
    # Shared flags, attached to every subcommand so they work in either
    # position: `semrush.py --limit 50 related X` or `semrush.py related X --limit 50`.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--db", default="us", help="regional database (default: us)")
    common.add_argument("--limit", type=int, default=25, help="max rows (default: 25)")
    common.add_argument("--min-volume", type=int, help="filter: volume >= N")
    common.add_argument("--max-kd", type=int, help="filter: difficulty <= N")
    common.add_argument("--min-kd", type=int, help="filter: difficulty >= N")
    common.add_argument("--max-competition", type=float, help="filter: paid competition <= 0-1")
    common.add_argument("--exclude", action="append",
                        help="exclude keywords containing TERM (repeatable)")
    common.add_argument("--json", action="store_true", help="output JSON")
    common.add_argument("--csv", help="also write rows to this CSV path")
    common.add_argument("--dry-run", action="store_true", help="print request, make no call")

    sub = p.add_subparsers(dest="cmd", required=True)

    def add(name, helptext):
        return sub.add_parser(name, help=helptext, parents=[common])

    for name, fn, helptext in [
        ("overview", cmd_overview, "one keyword: volume, CPC, competition, difficulty"),
        ("related", cmd_related, "semantically related keywords"),
        ("questions", cmd_questions, "question-form keywords (best GEO value)"),
        ("broad", cmd_broad, "broad-match keyword universe"),
    ]:
        s = add(name, helptext)
        s.add_argument("keyword")
        s.set_defaults(func=fn)

    s = add("difficulty", "keyword difficulty for one or more keywords")
    s.add_argument("keywords", nargs="+")
    s.set_defaults(func=cmd_difficulty)

    s = add("domain", "keywords a domain ranks for")
    s.add_argument("domain")
    s.set_defaults(func=cmd_domain)

    s = add("url", "keywords a specific URL ranks for")
    s.add_argument("url")
    s.set_defaults(func=cmd_url)

    s = add("competitors", "organic competitors of a domain")
    s.add_argument("domain")
    s.set_defaults(func=cmd_competitors)

    s = add("gap", "keywords competitors rank for that you don't")
    s.add_argument("domain", help="your domain")
    s.add_argument("competitors", nargs="+", help="1-4 competitor domains")
    s.set_defaults(func=cmd_gap)

    s = add("balance", "remaining API units")
    s.set_defaults(func=cmd_balance)

    s = add("cost", "estimate unit cost without calling the API")
    s.add_argument("report", help="subcommand name, e.g. related")
    s.set_defaults(func=cmd_cost)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
