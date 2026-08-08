---
name: blog-seo-geo
description: Research, plan, write, optimize, and grow blog content and Medium articles for both traditional search (SEO) and AI answer engines (GEO — getting cited by ChatGPT, Perplexity, Google AI Overviews, Gemini, Claude). Includes reverse-engineered growth systems from top operators (Backlinko, Ahrefs, Wait But Why, Julian Shapiro, James Clear, Nat Eliason, Tim Denning, Nicolas Cole, Ali Abdaal) and working scripts that call the Semrush API for keyword research, competitor gap analysis, keyword difficulty, and topical mapping. Use this skill whenever the user asks for a blog post, article, Medium story, content brief, topic cluster, keyword research, competitor content analysis, SEO audit, headline options, meta description, internal linking plan, content calendar for a blog, or help ranking / getting cited — and also when they say things like "why is my blog not getting traffic", "write an article about X", "rewrite this post to rank", "what should I blog about", "make this AI-search friendly", or "analyze my competitor's content". Trigger even if they never say the words SEO, GEO, or keyword.
---

# Blog, SEO & GEO

Two things now decide whether writing gets read: whether it ranks, and whether it gets *cited inside an AI answer*. These are related but not identical, and optimizing for only one leaves most of the value on the table.

The governing principle: **GEO is an additive layer on top of solid SEO, not a replacement.** Content that already ranks well tends to get cited well. Crawlable, fast, trustworthy pages with genuine expertise remain the foundation. Everything in this skill assumes that base.

---

## The workflow

```
0. Diagnose  →  what does this person actually need?
1. Research  →  keywords, intent, competitors, prompts   [scripts/semrush.py]
2. Map       →  topical map: pillar + cluster            [assets/topical-map.md]
3. Brief     →  one article's spec before writing        [assets/content-brief.md]
4. Write     →  craft-first, structured for extraction   [references/craft.md]
5. Optimize  →  on-page SEO + GEO signals                [scripts/content_audit.py]
6. Distribute→  platform choice, syndication, links      [references/platforms.md]
7. Measure   →  rankings, citations, decay, refresh
```

Don't run all seven for every request. Someone asking "write me a post about X" usually needs 3–5. Someone asking "why isn't my blog growing" needs 0–2 and 7.

---

## Step 0 — Diagnose

Establish these before doing anything. Infer from context where you can; ask in one batch where you can't. Cap it at four questions.

1. **The site or platform.** Own domain? Medium? Both? Domain age and rough authority matter enormously for what's realistically rankable.
2. **The audience and the goal.** Traffic, leads, authority, subscribers, product sales? This determines whether to chase volume or intent.
3. **The topic territory.** Not a keyword — a territory. "B2B SaaS onboarding" not "onboarding tips."
4. **What exists already.** Existing posts determine whether to write new, refresh old, or consolidate.
5. **Tool access.** Do they have a Semrush key, Ahrefs, GSC access, or nothing? This changes the research method, not whether research happens — see `references/keyword-research.md` for the no-tools path.

**The hard truth to deliver early when relevant:** a brand-new site cannot rank for competitive head terms, no matter how good the article is. If someone with a 3-month-old blog wants to rank for "best CRM," say so and redirect them to the long tail. Setting a false expectation wastes months of their work.

---

## Step 1 — Research

Read `references/keyword-research.md` for the full workflow. It covers both the API path and the free path.

**If a Semrush key is available** (`SEMRUSH_API_KEY` in env), use `scripts/semrush.py`. It handles keyword overview, related terms, question keywords, difficulty, competitor gap analysis, and domain/URL keyword pulls, with built-in unit-cost estimation so you don't burn the user's API budget.

```bash
python scripts/semrush.py overview "topic" --db us
python scripts/semrush.py related "topic" --limit 50 --min-volume 100 --max-kd 45
python scripts/semrush.py questions "topic" --limit 50
python scripts/semrush.py gap mysite.com competitor1.com competitor2.com --max-kd 50
python scripts/semrush.py competitors mysite.com
python scripts/semrush.py cost related --limit 200   # estimate before spending
```

Always run `--dry-run` or the `cost` subcommand first on large pulls and tell the user the estimated unit spend. Units are metered and don't roll over.

**Read `references/api-setup.md`** for key setup, other providers (Ahrefs, DataForSEO, Google Search Console, Google Trends), and cost control. Never ask the user to paste an API key into chat — have them set an environment variable.

**What you're looking for:**

- **Intent, before volume.** A 200-volume keyword whose searcher wants exactly what you sell beats a 20,000-volume keyword whose searcher wants a definition. Classify every target: informational, commercial investigation, transactional, navigational.
- **Winnable difficulty.** Match KD to site authority honestly.
- **Question keywords.** These are disproportionately valuable now because they map directly to AI prompts.
- **The gap.** What competitors rank for and the user doesn't. Highest-ROI list in SEO.
- **Prompts, not just keywords.** See Step 1b.

### Step 1b — Prompt research (the GEO half)

Keyword volume tells you about Google. It tells you nothing about what people type into ChatGPT, which is longer, more conversational, and often comparative ("what's the best X for someone who Y").

Build a prompt list of 15–30 questions a real person would ask an AI in this territory, then **actually run them** through the answer engines the user cares about and record who gets cited. This costs nothing and is the most revealing audit available. Track it monthly. Details in `references/geo.md`.

---

## Step 2 — Map the territory

**Single articles do not build authority. Clusters do.** This is the biggest structural shift in SEO and it holds for AI citation too: a site with 20 interconnected articles on one subject reliably outperforms a site with one excellent 5,000-word guide on it. Scattered posting on unconnected topics actively hurts.

Build a topical map *before* writing anything — see `assets/topical-map.md`.

```
PILLAR (broad, 3,000–5,000 words, links to every cluster page)
 ├── Cluster page (specific subtopic)  → links back to pillar
 ├── Cluster page
 ├── Cluster page  ...
```

Practical benchmarks:
- Aim for roughly **20–30 interlinked articles in one cluster** before spreading into a second territory or investing heavily in link acquisition.
- Every cluster page links back to the pillar with descriptive anchor text. Every pillar links out to every cluster page. Broken or missing internal links are the most common reason clusters fail.
- One page, one primary intent. Two pages targeting the same intent cannibalize each other — consolidate them.

Full mechanics in `references/seo.md`.

---

## Step 3 — Brief before writing

Never draft straight from a keyword. Fill `assets/content-brief.md` first: primary keyword, secondary keywords, the search intent, what the current top results actually contain, the **information gain angle** (what this piece will contain that no ranking page currently does), the target format, internal links in and out, and the primary prompt it should be cited for.

The information gain question is the one that matters most. Regurgitated content gets filtered out of AI context windows and no longer earns rankings. If you cannot answer "what does this contain that nothing else does," don't write it yet — go get original input: your own data, an experiment, interviews, a teardown, a real case with real numbers.

---

## Step 4 — Write

Read `references/craft.md` for headlines, structure, formats, and the writing patterns of top operators. Read `references/operators.md` for the full reverse-engineered systems.

The spine that satisfies humans, Google, and answer engines simultaneously:

**Answer first, then expand.** Open with a direct 40–60 word answer to the article's core question, then earn attention for the depth below it. This one habit serves everything: it satisfies impatient readers, it's what gets pulled into featured snippets, and it's the extractable chunk AI engines cite. Burying the answer under 800 words of preamble is the single most common self-inflicted wound in blogging.

**Then:**

- **H2s written as the questions people actually ask.** Not "Benefits" — "Why does topical authority beat keyword density?"
- **Self-contained sections.** Each section should make sense lifted out of context, because that's exactly what an AI engine does to it. Avoid "as mentioned above."
- **Short paragraphs, 2–4 sentences.** Extractability and mobile readability are the same problem.
- **Statistics with sources and dates.** Research on generative-engine optimization found adding statistics, citing sources, and including quotations produced the biggest gains in AI visibility — reported lifts up to ~40%. This is also just good writing.
- **Tables and comparison blocks.** Dense structured markup gets extracted preferentially.
- **First-person experience.** "We ran this on 40 client sites and here's what broke" is the E-E-A-T signal that cannot be faked or scraped.
- **A named author with a real bio, a visible publish and update date, and inline references.**

**What not to do:** keyword stuffing, padding to hit a word count, an intro that explains what the article will explain, AI-generic phrasing, or "in conclusion" summaries that restate the piece.

Length follows the query. Comparison posts run short and dense; definitive guides run long. Word count is an output, never a target.

---

## Step 5 — Optimize

Run the audit script on any draft or published URL:

```bash
python scripts/content_audit.py draft.md --keyword "target keyword"
python scripts/content_audit.py https://example.com/post --keyword "target keyword"
```

It reports on structure, extractability, statistic and citation density, heading form, answer-first compliance, keyword placement, internal/external linking, and freshness signals — then lists specific fixes. Treat its output as a checklist, not a score to game.

Then confirm the on-page essentials from `references/seo.md`: title tag (~50–60 chars, keyword early), meta description (~150–160, written to earn the click rather than to rank), one H1, clean descriptive slug, image alt text, and appropriate schema (`Article` plus `FAQPage` where genuinely applicable, `HowTo`, `Product`, or `Organization`/`Person` for entity clarity).

---

## Step 6 — Distribute

Read `references/platforms.md`. The short version:

- **Own domain vs. Medium is not either/or.** Own domain compounds equity you keep; Medium gives you a built-in audience and distribution from day one. The hybrid pattern — publish canonical on your own site, syndicate to Medium with `rel=canonical` — captures both without duplicate-content risk. Publishing natively on Medium first means Medium owns the SEO equity.
- **Medium's leverage is curation and publications.** Curated pieces reach dramatically more readers than uncurated ones, and publications provide instant distribution. Earnings there follow member *reading time* and engagement, not raw view counts — which means depth and completion matter more than clicks.
- **Distribution is not optional.** Publishing and waiting is the default failure mode. Every post needs a promotion plan: newsletter, communities where the reader already is, social atomization, and outreach to anyone quoted in it.
- **Links still matter**, but the classic skyscraper play has decayed badly — success rates that were once 10–20% now run closer to 1–3%, because everyone got the same outreach email. What still works is being genuinely the best resource *and* having a reason for someone to care that you exist: original data, a tool, a study, or a relationship.

---

## Step 7 — Measure and maintain

**Track:**
- Rankings and impressions (Google Search Console is free and the most honest source)
- Click-through rate by query — low CTR at a good position is a title/meta problem, not a ranking problem
- **AI citation rate** — run your prompt list monthly and record who's cited
- AI referral traffic (segment it in analytics; it converts at multiples of organic)
- Content decay — traffic declining on previously-good pages

**Refresh beats republish.** Updating an existing ranking article is usually higher-ROI than a new one. Every quarter: find decaying pages, update the data, add what's newly relevant, improve the answer-first block, re-date honestly, and re-promote.

**Consolidate cannibalization.** Two mediocre pages on the same intent should become one strong page with a redirect.

---

## Honest calibration

Say these out loud when relevant — they prevent wasted months:

- **SEO is slow.** Expect 3–6 months before meaningful movement on a new site, sometimes longer. Anyone promising faster is selling something.
- **AI citation lags publication**, commonly by several weeks, and depends heavily on whether the page is indexed and the domain is recognized.
- **Organic search still sends vastly more traffic than AI engines combined**, but AI referrals convert at far higher rates. Build for both; don't abandon one for the other.
- **Volume without a system is worthless.** Twenty interlinked articles on one topic beat a hundred scattered ones.
- **The numbers in these references will drift.** Search platforms change constantly. Verify anything the user is about to act on rather than quoting a benchmark as permanent fact.

---

## Reference files

- `references/operators.md` — reverse-engineered systems: Backlinko, Ahrefs, HubSpot, Wait But Why, Julian Shapiro, James Clear, Nat Eliason, Ali Abdaal, Tim Denning, Nicolas Cole, Paul Graham, and what to steal from each
- `references/seo.md` — 2026 SEO: topical authority, clusters, intent, on-page, technical, links, decay
- `references/geo.md` — generative engine optimization: per-engine mechanics, prompt research, citation auditing, measurement
- `references/keyword-research.md` — full research workflow, API and free paths, intent classification, prioritization scoring
- `references/craft.md` — headlines, article formats, structure, hooks, editing
- `references/platforms.md` — own blog vs. Medium vs. hybrid, canonical strategy, syndication, distribution
- `references/api-setup.md` — API keys, providers, endpoints, cost control

## Scripts

All are dependency-light (standard library only unless noted) and print human-readable output plus optional JSON.

- `scripts/semrush.py` — keyword research, difficulty, questions, competitor gap, domain/URL keywords, unit-cost estimation
- `scripts/content_audit.py` — SEO + GEO readiness audit of a draft file or live URL
- `scripts/keyword_cluster.py` — group a keyword list into a pillar/cluster topical map

## Assets

- `assets/content-brief.md` — per-article spec to fill before writing
- `assets/topical-map.md` — cluster planning grid
- `assets/article-template.md` — drafting scaffold with SEO/GEO structure baked in
