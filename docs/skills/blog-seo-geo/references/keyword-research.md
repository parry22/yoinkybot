# Keyword & Topic Research

The goal is never a list of keywords. It's a prioritized map of what to write, in what order, with a defensible reason for each item.

---

## The workflow

```
1. Seed        → 5-15 terms describing the territory
2. Expand      → related, questions, broad match, competitor gap
3. Classify    → intent, format, difficulty vs. site authority
4. Score       → business value × winnability × volume
5. Cluster     → pillar + cluster topical map
6. Sequence    → what to write first, and why
```

---

## Step 1 — Seeds

Don't start from a tool. Start from language.

- How does the audience describe the problem *in their words*? Not your product's words.
- What do customers actually ask, in support tickets, sales calls, and DMs?
- What do the top 3 competitors' blog categories reveal about their territory?
- What are the 5–10 things you know that most people in your field don't?

5–15 seed terms is enough. Tools expand seeds; they don't invent territories.

---

## Step 2 — Expand

### With the Semrush API

```bash
# Landscape check on one term
python scripts/semrush.py overview "topical authority" --db us

# Related terms, filtered for winnability
python scripts/semrush.py related "topical authority" \
    --limit 200 --min-volume 50 --max-kd 40 --csv related.csv

# Question keywords — highest GEO value, usually lowest difficulty
python scripts/semrush.py questions "topical authority" --limit 100 --csv questions.csv

# The broad universe (noisier, good for finding unexpected angles)
python scripts/semrush.py broad "topical authority" --limit 200 --min-volume 100

# Who actually competes with you organically
python scripts/semrush.py competitors mysite.com --limit 20

# The highest-ROI list in SEO: what they rank for and you don't
python scripts/semrush.py gap mysite.com comp1.com comp2.com \
    --limit 200 --min-volume 50 --max-kd 45 --csv gap.csv

# What's already working for a competitor's best page
python scripts/semrush.py url https://competitor.com/their-best-post --limit 50

# Then cluster it all
python scripts/keyword_cluster.py gap.csv --seed "topical authority"
```

**Always estimate cost first on large pulls.** Units are metered and don't roll over:

```bash
python scripts/semrush.py cost related --limit 500
python scripts/semrush.py balance
```

Tell the user the estimated spend before running anything over a few hundred rows. Use `--dry-run` to see the exact request without spending.

### Without any paid tool

This path is slower but genuinely workable, and it produces better intent reading than the API path because you're looking at real results.

1. **Google autocomplete.** Type the seed, then the seed + each letter a–z. Also try "seed for", "seed vs", "seed without", "seed best".
2. **People Also Ask.** Expand every box; each expansion generates more. This is a free question-keyword goldmine and maps directly to AI prompts.
3. **Related searches** at the bottom of the results page.
4. **Google Search Console.** Free and the best source you have if the site has any history: the Queries report shows terms you already get impressions for. Anything with impressions but a poor position is a page waiting to be improved — the fastest wins available.
5. **Google Trends.** Direction and seasonality, free.
6. **Reddit, Quora, Stack Exchange, niche forums.** Real phrasing, real problems. Also directly relevant because these platforms are heavily cited by AI engines.
7. **Competitor sitemaps.** `competitor.com/sitemap.xml` lists every page they've decided is worth writing.
8. **Amazon reviews and book indexes** in the subject area — reveals the questions people pay to have answered.
9. **Free tiers.** Ahrefs Webmaster Tools (free for verified sites), Semrush's limited free searches, Google Keyword Planner (free with an Ads account, though it buckets volume broadly).

**Read the SERP for every candidate keyword regardless of method.** No tool tells you what a difficulty score can't: whether the top results are actually weak.

---

## Step 3 — Classify

For every candidate, record:

| Field | Why |
|---|---|
| **Intent** | informational / commercial / transactional / navigational |
| **Format Google has chosen** | read the top 10 — guide, listicle, product page, tool, video |
| **Difficulty vs. your authority** | winnable now, later, or never |
| **Business value** | 0–3: does your offer naturally answer this? |
| **SERP weakness** | are the top results thin, outdated, or wrong? |
| **AI Overview present?** | changes the CTR math |
| **Prompt equivalent** | how would someone ask an AI this? |

**The format check is the one people skip and shouldn't.** If page one is entirely product pages, Google has decided the intent is transactional. A 3,000-word guide will not rank there no matter how good it is. Intent mismatch is the most common cause of good content that never ranks.

---

## Step 4 — Score and prioritize

Volume-first prioritization is the standard mistake. Use a simple composite instead:

```
Priority = Business value (0-3)
         × Winnability (0-3)
         × log(volume)
```

**Business value (0–3)**
- 3 — the searcher is close to needing exactly what you offer
- 2 — same audience, adjacent problem
- 1 — right audience, unrelated question
- 0 — wrong audience entirely

**Winnability (0–3)**
- 3 — KD well under your ceiling, and the current top results are weak
- 2 — KD at your ceiling, results are decent
- 1 — a stretch
- 0 — not this year

A 300-volume keyword at value 3, winnability 3 beats a 20,000-volume keyword at value 1, winnability 1. Almost always.

**Then sequence for compounding:** write the low-difficulty cluster pages first to build topical signal, and the pillar last — it's easier to write once the clusters exist, and it can then link to real pages rather than placeholders.

---

## Step 5 — Cluster

```bash
python scripts/keyword_cluster.py keywords.csv --seed "your head term" --min-cluster 3
```

The script groups lexically. **Verify with the SERP overlap test:** search two or three keywords from a proposed cluster. If the top 10 results are largely the same pages, those keywords belong on *one* page. If the results differ substantially, they need separate pages. This test is the actual authority on whether to split or merge, and it takes two minutes.

Then fill `assets/topical-map.md`.

---

## Step 6 — Prompt research

Do this alongside keyword research, not after. See `references/geo.md` for the full method.

Question keywords from `semrush.py questions` are the best raw material, but real prompts are longer and more situational than keywords. Write 15–30 of them in natural language, then run them through the engines and record who's cited.

---

## Common traps

**Chasing volume.** High volume plus zero business value produces traffic that converts at nothing and costs the same to write.

**Ignoring intent.** The most common cause of good content that never ranks.

**Trusting difficulty scores blindly.** A KD of 45 with three thin, five-year-old top results is easier than a KD of 25 with a definitive guide from a major brand at #1.

**One keyword per post, forever.** A well-built page ranks for dozens of related terms. Target a cluster of related keywords with one primary intent, not one exact string.

**Writing for a keyword instead of a question.** The keyword is a compressed signal. The question behind it is what you answer.

**Skipping Search Console.** If the site has history, the fastest wins in SEO are already sitting in the Queries report: terms with impressions and a bad position.

**Researching forever.** Twenty well-chosen keywords is enough to start. The first ten published pages teach you more about what works on your specific site than another month of research will.
