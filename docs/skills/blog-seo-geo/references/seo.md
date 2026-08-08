# SEO

Current as of mid-2026. Search platforms change constantly — verify anything the user is about to act on rather than treating a benchmark here as permanent.

---

## The shift that matters

Search moved from **page-level** to **site-level** evaluation. Google's Helpful Content systems (2022–2024) and the March 2026 core update consolidated it: the question is no longer "does this page match this query" but "does this site demonstrate genuine, connected expertise in this subject."

Practical consequence, reported consistently across analyses of the March 2026 update: **a site with ~20 interconnected articles on a subject outranks a site with one excellent 5,000-word guide on it**, even when the single article is technically superior in isolation. Roughly 55% of sites saw ranking shifts in that update; those with comprehensive topical coverage climbed, those with scattered thin content fell.

So: publishing unconnected articles on unrelated topics doesn't just fail to help — it actively dilutes site-level signals.

---

## Topical authority and clusters

### The architecture

```
PILLAR PAGE — 3,000-5,000 words, broad coverage, links to every cluster page
   │
   ├── Cluster page — one subtopic, in depth, links back to pillar + siblings
   ├── Cluster page
   ├── Cluster page
   └── ... aim for 20-30 before expanding territory
```

### Rules that decide whether it works

- **Build the map before writing.** A topical map is planned up front — main topic, subtopics, questions, comparisons, edge cases. Written after the fact it's just a sitemap.
- **Internal linking is the mechanism, not decoration.** Every cluster page links to the pillar with descriptive anchor text containing the pillar's target term. The pillar links to every cluster page. Missing or broken internal links is the most common failure mode.
- **One page, one intent.** Two pages targeting the same intent cannibalize each other. Consolidate into one strong page and redirect.
- **Thin pillars sink the cluster.** A shallow pillar undermines the authority signal for everything pointing at it.
- **Finish one territory before starting another.** Reported benchmark: roughly 25–30 quality interlinked articles in a cluster before investing heavily in link acquisition.

### Expected returns

Sites implementing clusters properly report roughly 40% more organic traffic than non-clustered strategies; transitions from keyword-focused to cluster models report 50–300% over 6–12 months. Treat these as directional. The mechanism is real; the multiplier depends entirely on starting point and execution.

---

## Search intent

Intent classification comes before volume, always. A 200-volume keyword whose searcher wants exactly what you offer beats a 20,000-volume keyword whose searcher wants a definition.

| Intent | Searcher wants | Content type | Business value |
|---|---|---|---|
| **Informational** | To understand | Guide, explainer, how-to | Low direct, high authority |
| **Commercial** | To decide between options | Comparison, review, "best X" | High |
| **Transactional** | To act now | Product page, pricing, signup | Highest |
| **Navigational** | A specific destination | Brand pages | Low unless it's your brand |

**How to classify honestly: look at what currently ranks.** If page one is all product pages, Google has decided the intent is transactional and your 3,000-word guide will not rank no matter how good it is. The SERP is the answer key.

**Intent mismatch is the most common reason good content doesn't rank.** Before writing, open the results and ask: what format has Google already chosen for this query?

---

## Keyword difficulty and realistic targeting

Difficulty scores are relative to *your* site, not absolute. Rough calibration:

| Site authority | Realistic KD ceiling | Strategy |
|---|---|---|
| New (0–6 months) | KD < 20 | Long tail, questions, very specific |
| Establishing (6–18 mo) | KD < 35 | Build the cluster, some mid-tail |
| Established | KD < 55 | Compete on mid-tail, occasional head |
| Authority in niche | Most terms | Head terms become winnable |

**Say this plainly when relevant.** A three-month-old blog cannot rank for "best CRM." Telling someone otherwise costs them months. Redirect to the long tail — which is also where AI-engine citation opportunity is highest, because the queries are more specific.

**Read the SERP before trusting a KD number.** Weak, outdated, or plainly wrong top results are an opening no difficulty score captures.

---

## On-page essentials

**Title tag.** ~50–60 characters. Primary keyword early. Written to earn a click, not just to contain the keyword. This is often the single highest-leverage fix on an underperforming page — low CTR at a good position is a title problem, not a ranking problem.

**Meta description.** ~150–160 characters. Not a ranking factor directly; it's ad copy for the click. Include the keyword so it bolds in results.

**URL slug.** Short, descriptive, keyword-bearing, hyphens. `/topical-authority` not `/2026/03/post-4471`. Never change a ranking URL without a 301.

**H1.** Exactly one. Contains the primary keyword naturally.

**H2s.** One every 250–400 words. **Phrase them as the questions people actually ask** — "Why does topical authority beat keyword density?" not "Benefits." This serves skimmers, snippets, voice search, and AI extraction simultaneously.

**Body.** Primary keyword in the first ~100 words. Natural variants and semantically related terms throughout. Density is not a target — anything above roughly 2.5% reads as stuffing.

**Images.** Descriptive filenames, real alt text, compressed, correct dimensions. Custom diagrams earn links; stock photos earn nothing.

**Schema.** `Article` as a baseline. Add `FAQPage` only where the questions are genuinely on the page, `HowTo` for procedures, `Product` for products, `Organization`/`Person` for entity clarity. Note that Google has said special schema is not required for its generative features — but structured data still helps conventional rich results and general machine legibility.

---

## Technical foundations

These are prerequisites, not optimizations. A page that isn't crawlable can't rank or be cited.

- **Indexable.** Check Search Console coverage. Not in the index means invisible everywhere, including AI answers.
- **Fast.** Core Web Vitals. Mobile especially.
- **Mobile-first.** Google indexes the mobile version.
- **HTTPS**, clean sitemap, sane robots.txt.
- **Crawlable to AI bots too.** If you block GPTBot, PerplexityBot, ClaudeBot, or similar in robots.txt, you have opted out of AI citation. That may be a deliberate choice — make it deliberately, not by accident.
- **Submit to Bing Webmaster Tools.** ChatGPT's web search has drawn on Bing's index; being absent there removes a citation path that costs nothing to open.

---

## Links

Still a real signal, but the classic playbook has decayed.

**What still works:**
- **Linkable assets.** Original research, free tools, annual reports, definitive datasets. These earn links passively for years — the highest-ROI thing in link building.
- **Digital PR.** Being quoted, cited, or covered by credible publications. This also raises AI citation odds, since answer engines lean on well-referenced sources.
- **Genuine relationships.** Guest posts, podcast appearances, collaborations, being useful in communities.
- **Unlinked mention reclamation.** Find places you're mentioned without a link and ask.

**What has decayed:**
- **Cold skyscraper outreach.** Success rates reported down from 10–20% originally to roughly 1–3%. Everyone gets the same email. The underlying logic — be the best resource — still holds; the outreach step is what stopped working.
- **Directory and low-quality link buying.** Risk without return.

**Internal links remain undervalued** and are entirely within your control. They distribute authority, define your cluster, and cost nothing.

---

## Content decay and maintenance

Content decays. Traffic on previously-good pages declines as competitors update and search intent shifts. Maintenance is not optional.

**Quarterly routine:**

1. **Find decaying pages.** Search Console: pages losing impressions or position over the last 3–6 months.
2. **Refresh, don't republish.** Update data, add newly relevant sections, improve the answer-first block, fix broken links, tighten the title. Keep the URL.
3. **Re-date honestly.** Update the modified date when you've genuinely updated it. Don't fake it.
4. **Re-promote.** A refreshed post deserves the same distribution push as a new one.
5. **Find cannibalization.** Two pages ranking for the same query means neither is ranking as well as one would. Consolidate and 301.
6. **Prune.** Content that never worked and never will drags site-level quality. Delete or consolidate it.

**Refresh is usually higher-ROI than net-new.** A page already ranking on page two needs far less work to reach page one than a new page needs to reach page two.

---

## Measurement

**Google Search Console is free and the most honest source you have.** Third-party tools estimate; GSC reports.

Track:
- **Impressions and average position** by query — the leading indicator
- **CTR by query** — low CTR at position 3–5 is a title/meta problem
- **Pages per cluster ranking** — is the cluster working as a unit?
- **Content decay** — pages declining month over month
- **Conversions by landing page**, not just sessions

Ignore: vanity domain authority scores as a goal, keyword density, word count as a target.

---

## Timelines

- **New site:** 3–6 months before meaningful movement, often longer in competitive niches.
- **Established site, new post:** weeks to a few months.
- **Cluster maturity:** 6–12 months to see the compounding effect.
- **Refresh:** often the fastest win — days to weeks.

Anyone promising faster on a new domain is selling something.
