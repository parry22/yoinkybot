#!/usr/bin/env python3
"""
content_audit.py — audit a draft or published article for SEO + GEO readiness.

    python content_audit.py draft.md --keyword "topical authority"
    python content_audit.py https://example.com/post --keyword "topical authority"
    python content_audit.py draft.md --keyword "x" --secondary "y" "z" --json

Accepts markdown, plain text, HTML files, or a live URL (stdlib only; no
dependencies). Reports on the structural signals that matter for ranking in
search AND for being extracted and cited by AI answer engines.

This is a checklist generator, not a score to game. A piece can fail several
checks and still be excellent — read the findings, apply judgement. What it
cannot measure is whether the writing is any good or whether it contains
information that exists nowhere else, which are the two things that matter most.
"""

import argparse
import html
import json
import re
import sys
import urllib.request
from datetime import datetime

UA = "Mozilla/5.0 (compatible; content-audit/1.0)"

QUESTION_WORDS = ("what", "why", "how", "when", "where", "who", "which",
                  "is", "are", "can", "should", "does", "do", "will")

WEAK_OPENERS = (
    "in today's", "in the world of", "in this article", "we will explore",
    "this post will", "let's dive in", "in an era of", "it's no secret",
    "when it comes to", "in this day and age", "as we all know",
)

AI_TELLS = (
    "delve", "tapestry", "landscape of", "navigate the", "unlock the",
    "it's important to note", "in conclusion", "furthermore", "moreover",
    "game-changer", "leverage the power", "at the intersection of",
    "seamlessly", "robust solution", "in the realm of", "ever-evolving",
)


# ---------------------------------------------------------------- loading

def strip_html(raw):
    raw = re.sub(r"(?is)<(script|style|nav|footer|header|aside)[^>]*>.*?</\1>", " ", raw)
    # convert headings/paragraphs to markdown-ish so structure survives
    for n in range(1, 7):
        raw = re.sub(rf"(?is)<h{n}[^>]*>(.*?)</h{n}>", lambda m, n=n: f"\n{'#'*n} {m.group(1)}\n", raw)
    raw = re.sub(r"(?is)<li[^>]*>", "\n- ", raw)
    raw = re.sub(r"(?is)</p>|<br\s*/?>", "\n\n", raw)
    raw = re.sub(r"(?s)<[^>]+>", " ", raw)
    raw = html.unescape(raw)
    return re.sub(r"[ \t]{2,}", " ", raw)


def load(source):
    """Return (text, raw, is_url)."""
    if source.startswith(("http://", "https://")):
        req = urllib.request.Request(source, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                raw = r.read().decode("utf-8", errors="replace")
        except Exception as e:
            sys.exit(f"Could not fetch {source}: {e}")
        return strip_html(raw), raw, True

    try:
        raw = open(source, encoding="utf-8").read()
    except OSError as e:
        sys.exit(f"Could not read {source}: {e}")
    text = strip_html(raw) if re.search(r"<(html|body|h1|p)\b", raw, re.I) else raw
    return text, raw, False


# ---------------------------------------------------------------- parsing

def parse(text):
    lines = text.splitlines()
    headings = []
    for ln in lines:
        m = re.match(r"^(#{1,6})\s+(.*)", ln.strip())
        if m:
            headings.append((len(m.group(1)), m.group(2).strip()))

    body = "\n".join(l for l in lines if not re.match(r"^#{1,6}\s", l.strip()))
    paras = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
    prose = [p for p in paras if not p.lstrip().startswith(("-", "*", "|", ">", "1."))]
    words = re.findall(r"\b[\w'-]+\b", body)
    sentences = [s for s in re.split(r"(?<=[.!?])\s+", body) if s.strip()]

    return {
        "headings": headings,
        "paragraphs": paras,
        "prose": prose,
        "words": words,
        "sentences": sentences,
        "text": text,
        "body": body,
    }


# ---------------------------------------------------------------- checks

def audit(text, raw, keyword, secondary, is_url):
    d = parse(text)
    low = text.lower()
    wc = len(d["words"])
    findings = []   # (severity, area, message)

    def add(sev, area, msg):
        findings.append({"severity": sev, "area": area, "message": msg})

    # ---- length & structure -------------------------------------------
    if wc < 300:
        add("high", "length", f"{wc} words. Too thin to demonstrate depth on almost any topic.")
    elif wc < 700:
        add("med", "length", f"{wc} words. Workable for a narrow question, thin for a guide.")

    h1s = [h for lvl, h in d["headings"] if lvl == 1]
    h2s = [h for lvl, h in d["headings"] if lvl == 2]
    if len(h1s) == 0:
        add("high", "structure", "No H1. Every page needs exactly one.")
    elif len(h1s) > 1:
        add("high", "structure", f"{len(h1s)} H1s. Use exactly one; demote the rest to H2.")

    if not h2s:
        add("high", "structure", "No H2 sections. Unbroken text is hard to skim and hard to extract.")
    elif wc > 900 and len(h2s) < wc / 500:
        add("med", "structure", f"Only {len(h2s)} H2s for {wc} words. Aim for one every 250-400 words.")

    q_h2 = [h for h in h2s if h.lower().split()[0] in QUESTION_WORDS] if h2s else []
    if h2s and len(q_h2) < max(1, len(h2s) // 3):
        add("med", "geo", f"Only {len(q_h2)}/{len(h2s)} H2s are phrased as questions. "
                          "Question headings map directly to AI prompts and voice queries.")

    label_h2 = [h for h in h2s if len(h.split()) <= 2]
    if label_h2:
        add("low", "structure", f"Label-style headings ({', '.join(label_h2[:3])}). "
                                "Statement or question headings carry more information.")

    # ---- extractability ------------------------------------------------
    long_paras = [p for p in d["prose"] if len(p.split()) > 90]
    if long_paras:
        add("med", "geo", f"{len(long_paras)} paragraph(s) over 90 words. "
                          "Long blocks resist extraction; split to 2-4 sentences.")

    if d["prose"]:
        avg = sum(len(p.split()) for p in d["prose"]) / len(d["prose"])
        if avg > 70:
            add("med", "readability", f"Average paragraph is {avg:.0f} words. Aim for 40-60.")

    long_sents = [s for s in d["sentences"] if len(s.split()) > 35]
    if len(long_sents) > len(d["sentences"]) * 0.15 and d["sentences"]:
        add("low", "readability", f"{len(long_sents)} sentence{'' if len(long_sents)==1 else 's'} "
                                      "over 35 words. Break some up.")

    # answer-first check: is there a tight direct answer in the opening?
    opener = " ".join(d["prose"][:2]) if d["prose"] else ""
    first_words = len(opener.split())
    if first_words > 120:
        add("high", "geo", "No tight answer up front. Open with a direct 40-60 word answer to "
                           "the core question, then expand. This is what gets pulled into "
                           "snippets and AI answers.")
    if any(opener.lower().lstrip().startswith(w) for w in WEAK_OPENERS):
        add("med", "craft", "Opening uses a throat-clearing phrase. Start with the answer or a specific.")

    # ---- evidence density ----------------------------------------------
    stats = re.findall(r"(?<![\w/])\d[\d,.]*\s*(?:%|percent|x\b|million|billion|k\b)", low)
    stats += re.findall(r"\$\s?\d[\d,.]*", low)
    per_1k = len(stats) / max(wc, 1) * 1000
    if per_1k < 2:
        add("high", "geo", f"Only {len(stats)} concrete figures ({per_1k:.1f} per 1k words). "
                           "Adding statistics is one of the strongest known levers on AI "
                           "citation rate. Target 4+ per 1k words, each sourced.")
    elif per_1k < 4:
        add("med", "geo", f"{len(stats)} figures ({per_1k:.1f} per 1k words). More would help.")

    links = re.findall(r"\[([^\]]*)\]\(([^)]+)\)", text) + \
            [(m.group(2), m.group(1)) for m in re.finditer(r'<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)</a>', raw, re.I | re.S)]
    ext = [u for u, _ in [(b, a) for a, b in links] if u.startswith("http")]
    internal = [u for u, _ in [(b, a) for a, b in links] if not u.startswith(("http", "#", "mailto"))]

    if len(ext) < 3:
        add("high", "geo", f"{len(ext)} external citation{'' if len(ext)==1 else 's'}. "
                           "Outbound links to primary sources are "
                           "a trust signal for both search and answer engines. Cite what you claim.")
    if not is_url and len(internal) < 2:
        add("med", "seo", f"{len(internal)} internal link{'' if len(internal)==1 else 's'}. "
                          "Every cluster page should link to its "
                          "pillar and to sibling pages — this is what makes a cluster a cluster.")

    quotes = len(re.findall(r'"[^"]{25,}"', text)) + len(re.findall(r"^>\s", text, re.M))
    if quotes == 0:
        add("low", "geo", "No quotations. Quoting a named source raises credibility and "
                          "measurably improves AI citation odds.")

    has_table = bool(re.search(r"^\|.*\|", text, re.M) or re.search(r"<table", raw, re.I))
    has_list = bool(re.search(r"^\s*[-*]\s|^\s*\d+\.\s", text, re.M) or re.search(r"<[uo]l\b", raw, re.I))
    if not has_table:
        add("low", "geo", "No table. Comparison tables are extracted preferentially by AI engines "
                          "and win featured snippets.")
    if not has_list:
        add("low", "structure", "No lists. Some structured breakdown usually helps scannability.")

    # ---- keyword usage -------------------------------------------------
    if keyword:
        k = keyword.lower()
        count = low.count(k)
        density = count / max(wc, 1) * 100
        title_line = h1s[0].lower() if h1s else (d["headings"][0][1].lower() if d["headings"] else "")

        if k not in title_line:
            add("high", "seo", f'Primary keyword "{keyword}" is not in the H1/title.')
        opening = " ".join(d["prose"][:3]).lower()
        if k not in opening and not all(w in opening for w in k.split()):
            add("med", "seo", f'"{keyword}" does not appear in the opening. '
                              "Put it in the first ~100 words, naturally.")
        if not any(k in h.lower() for _, h in d["headings"][1:]):
            add("med", "seo", f'"{keyword}" or a variant does not appear in any subheading.')
        if count == 0:
            add("high", "seo", f'"{keyword}" never appears in the body.')
        elif density > 2.5:
            add("high", "seo", f'"{keyword}" appears {count}x ({density:.1f}%). '
                               "That reads as stuffing — use natural variants instead.")
        else:
            add("info", "seo", f'"{keyword}": {count} occurrence'
                               f"{'' if count == 1 else 's'} ({density:.2f}%). Reasonable.")

    for s in (secondary or []):
        if s.lower() not in low:
            add("low", "seo", f'Secondary keyword "{s}" is absent.')

    # ---- trust signals -------------------------------------------------
    has_date = bool(re.search(r"\b(20\d\d)\b", text[:1500])) or \
               bool(re.search(r'(datePublished|dateModified|article:published)', raw, re.I))
    if not has_date:
        add("med", "geo", "No visible date. Answer engines weight freshness and dated content "
                          "heavily; show publish and update dates.")

    has_author = bool(re.search(r'\b(by|author|written by)\b\s+[A-Z]', text[:1500], re.I)) or \
                 bool(re.search(r'(rel="author"|"author"\s*:|itemprop="author")', raw, re.I))
    if not has_author:
        add("med", "geo", "No visible author attribution. A named author with a real bio is a "
                          "core E-E-A-T and citation signal.")

    experience = re.findall(r"\b(I |we |our |my |in my experience|when we|after (?:we|I))\b", text, re.I)
    if len(experience) < 3:
        add("med", "eeat", "Little first-person experience. Firsthand accounts, original tests, "
                           "and real numbers are the E-E-A-T signal that cannot be scraped.")

    if is_url or re.search(r"<script[^>]*application/ld\+json", raw, re.I):
        if not re.search(r"application/ld\+json", raw, re.I):
            add("med", "seo", "No JSON-LD schema found. Add Article, plus FAQPage or HowTo "
                              "where genuinely applicable.")

    # ---- meta (URL only) -----------------------------------------------
    if is_url:
        t = re.search(r"<title[^>]*>(.*?)</title>", raw, re.I | re.S)
        if t:
            title = html.unescape(t.group(1)).strip()
            if len(title) > 62:
                add("med", "seo", f"Title tag is {len(title)} chars; likely truncated in SERPs. "
                                  "Aim for 50-60.")
            if keyword and keyword.lower() not in title.lower():
                add("med", "seo", "Primary keyword is not in the title tag.")
        else:
            add("high", "seo", "No <title> tag found.")

        m = re.search(r'<meta[^>]+name="description"[^>]+content="([^"]*)"', raw, re.I)
        if not m:
            add("high", "seo", "No meta description.")
        else:
            n = len(m.group(1))
            if n > 165 or n < 70:
                add("low", "seo", f"Meta description is {n} chars; 150-160 displays best.")

        imgs = re.findall(r"<img\b[^>]*>", raw, re.I)
        no_alt = [i for i in imgs if not re.search(r'\balt="[^"]+"', i, re.I)]
        if no_alt:
            add("low", "seo", f"{len(no_alt)}/{len(imgs)} images missing alt text.")

    # ---- writing tells --------------------------------------------------
    tells = sorted({t for t in AI_TELLS if t in low})
    if tells:
        add("low", "craft", f"Generic/AI-tell phrasing: {', '.join(tells[:6])}"
                            f"{'...' if len(tells) > 6 else ''}. Rewrite in your own register.")

    return {
        "words": wc,
        "headings": len(d["headings"]),
        "h2": len(h2s),
        "question_h2": len(q_h2),
        "paragraphs": len(d["prose"]),
        "statistics": len(stats),
        "external_links": len(ext),
        "internal_links": len(internal),
        "quotes": quotes,
        "has_table": has_table,
        "has_list": has_list,
        "findings": findings,
    }


# ---------------------------------------------------------------- output

SEV_ORDER = {"high": 0, "med": 1, "low": 2, "info": 3}
SEV_LABEL = {"high": "FIX", "med": "IMPROVE", "low": "CONSIDER", "info": "OK"}


def report(res, source, keyword):
    print(f"\nContent audit — {source}")
    if keyword:
        print(f"Primary keyword: {keyword}")
    print("=" * 68)
    print(f"words {res['words']:<7} headings {res['headings']:<5} "
          f"H2 {res['h2']:<4} question-H2 {res['question_h2']:<4} paras {res['paragraphs']}")
    print(f"stats {res['statistics']:<7} ext-links {res['external_links']:<4} "
          f"int-links {res['internal_links']:<4} quotes {res['quotes']:<5} "
          f"table {'y' if res['has_table'] else 'n'}  list {'y' if res['has_list'] else 'n'}")
    print("=" * 68)

    fs = sorted(res["findings"], key=lambda f: (SEV_ORDER[f["severity"]], f["area"]))
    if not fs:
        print("\nNo issues found.")
    current = None
    for f in fs:
        if f["severity"] != current:
            current = f["severity"]
            print(f"\n[{SEV_LABEL[current]}]")
        print(f"  ({f['area']}) {f['message']}")

    high = sum(1 for f in fs if f["severity"] == "high")
    print(f"\n{high} blocking issue(s), {len(fs)} finding(s) total.")
    print("\nThis audit measures structure, not substance. It cannot tell you whether "
          "the piece\ncontains information that exists nowhere else — which is the thing "
          "that actually\ndecides whether it ranks or gets cited.")


def main():
    p = argparse.ArgumentParser(description="Audit an article for SEO + GEO readiness.")
    p.add_argument("source", help="path to .md/.txt/.html, or a URL")
    p.add_argument("--keyword", help="primary target keyword")
    p.add_argument("--secondary", nargs="*", default=[], help="secondary keywords")
    p.add_argument("--json", action="store_true", help="emit JSON")
    args = p.parse_args()

    text, raw, is_url = load(args.source)
    res = audit(text, raw, args.keyword, args.secondary, is_url)
    res["source"] = args.source
    res["audited_at"] = datetime.now().isoformat(timespec="seconds")

    if args.json:
        print(json.dumps(res, indent=2))
    else:
        report(res, args.source, args.keyword)


if __name__ == "__main__":
    main()
