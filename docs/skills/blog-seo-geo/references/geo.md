# GEO — Generative Engine Optimization

Getting cited *inside* AI-generated answers, rather than ranked as a blue link beside them.

**The foundational point, stated by Google itself and confirmed by every credible analysis: GEO is an additive layer on solid SEO, not a replacement.** Content that already ranks well tends to perform well in AI Overviews. Crawlable, fast, trustworthy pages with real expertise remain the base. There is no separate AI-only content strategy that works without that base.

Everything below changes fast. Verify before acting.

---

## Why it matters, honestly

**The case for:**
- AI search handles an estimated 12–18% of English informational queries as of early 2026, up from under 2% a year prior. The curve is steep.
- Google AI Overviews appear in roughly 25–40% of queries depending on whose measurement you use.
- Organic CTR has fallen sharply on queries where an AI Overview appears — reported around a 61% decline.
- AI referral traffic converts at multiples of organic. Reported figures put ChatGPT around 14–16%, Perplexity around 10%, versus organic around 1.8%.
- Citation matters even without a click. Users act on the information directly — buying the product you were cited as recommending.

**The case for not over-rotating:**
- Organic search still sends vastly more total traffic than all AI engines combined — one 2025 estimate put the ratio at several hundred to one.
- Measurement is fragmented and immature.
- Paid placement in AI answers is being piloted, which will change the dynamics.

**Correct posture:** build for both. The work overlaps by roughly 80%.

---

## What actually moves citation rate

The foundational academic work here (Aggarwal et al., Princeton / Georgia Tech / IIT Delhi, KDD 2024) tested optimization methods against generative engines and found visibility lifts up to ~40%. The three highest-impact interventions:

1. **Statistics addition** — replacing vague claims with specific figures
2. **Citing sources** — attributing claims to named, linkable sources
3. **Quotation addition** — including direct quotes from credible people

All three are also just markers of good writing, which is the reassuring part: there is no trick here that diverges from writing well.

Adding to that, from current practitioner analysis:

4. **Information gain.** Regurgitated content gets filtered out of context windows. Unique perspective, original data, and firsthand experience are what survive the filter.
5. **Dense, extractable structure.** Bolded data points, comparison tables, tight self-contained paragraphs.
6. **Topical connectivity.** A connected topical graph, not isolated pages — the same cluster architecture that serves SEO.
7. **Third-party authority.** Credible coverage and digital PR raise citation odds. Being talked about elsewhere is a signal these systems weight heavily.

---

## The structural rules

### Answer first

Open every page with a direct, self-contained answer to its core question in roughly 40–60 words, then expand. This single habit does more for GEO than anything else, because it produces exactly the extractable chunk an engine needs.

> **What is topical authority?** Topical authority is a site-level signal reflecting how comprehensively a site covers a subject. Search engines evaluate breadth and depth across many interconnected pages rather than judging each page alone — which is why a site with twenty linked articles on one topic typically outranks a site with one excellent guide.

Then the depth below it earns the reader.

### Self-contained sections

Write each section so it makes sense lifted out of context, because that is precisely what happens to it. Avoid "as mentioned above," "as we discussed," and pronouns whose referent is three paragraphs up. Every H2 section should be independently quotable.

### Question headings

H2s phrased as the questions people actually ask map directly to prompts. "How long does SEO take to work?" beats "Timelines."

### Chunk size

Paragraphs of 2–4 sentences. Long blocks resist extraction.

### Structured data blocks

Comparison tables, definition blocks, numbered procedures, and pros/cons lists get extracted preferentially. A well-built comparison table is one of the highest-value assets on a page.

### Entity clarity

Answer engines reason about entities. Be explicit about who you are, what your organization is, and how things relate. Consistent naming across your site, your About page, your author bios, and third-party mentions helps these systems recognize you as a distinct entity worth citing.

---

## Trust signals

These matter more for AI citation than for conventional ranking:

- **Named author with a real bio and credentials.** Not "Admin." Not "The Team."
- **Visible publish and update dates.** Freshness is weighted heavily.
- **Inline references to primary sources.** Link out. Generously.
- **First-person experience.** "We tested this across 40 sites and here's what broke." This is the E-E-A-T signal that cannot be scraped or synthesized, and it's increasingly the differentiator.
- **Consistency across the web.** Your bio, your claims, and your naming should match wherever they appear.

---

## Per-engine notes

Each engine selects differently. These behaviors shift — verify rather than assume.

**ChatGPT Search.** Generates inline hyperlinked citations with a Sources panel for informational and commercial queries. Its web search has drawn on Bing's index, so submitting a sitemap to Bing Webmaster Tools is a cheap, concrete step. Appears to weight domain reputation and readability.

**Google AI Overviews / AI Mode.** Citation chips inline in the overview. In AI Mode, deep forum threads (Reddit, Quora) surface alongside authoritative editorial domains via its perspectives framework. Content that already ranks conventionally is the strongest predictor of appearing here. Google has stated that llms.txt files, AI-specific content rewriting, and special schema are *not* needed for its generative features.

**Perplexity.** The most publisher-friendly — favicons, author bylines, explicit source cards for factual assertions. Citation-first by design, which makes it the best engine for testing whether your content is citable at all.

**Gemini.** Citation chips within AI Overview text blocks; similar dynamics to Google's other surfaces.

**Claude.** Cites sources when searching. Same fundamentals apply.

**Cross-cutting:** Reddit and Wikipedia are among the most heavily cited sources across engines. Presence on community platforms and authoritative reference sites is a legitimate part of a GEO strategy — not as spam, but as genuine participation where your audience already is.

---

## Prompt research

Keyword volume describes Google. It says nothing about what people type into an AI, which is longer, conversational, and often comparative.

**Build a prompt list.** 15–30 questions a real person would ask an AI in your territory. Sources:
- Your question keywords (`semrush.py questions "topic"`)
- Actual questions from customers, support tickets, sales calls, and comments
- "Best X for Y" and "X vs Y" comparative phrasings
- Problem-shaped prompts: "I need to do X but Y — what should I use?"
- Semrush's AI Visibility Toolkit has a Prompt Research report if the user has access to it

**Then run them.** Manually, in each engine, and record who gets cited. This is the ground truth, it costs nothing, and nearly nobody does it.

---

## The citation audit

Run monthly. This is the single most revealing GEO activity available.

| Prompt | Engine | Cited? | Position | Who else was cited | Notes |
|---|---|---|---|---|---|
| | ChatGPT | | | | |
| | Perplexity | | | | |
| | AI Overview | | | | |
| | Gemini | | | | |

**Read the results for patterns:**
- **Who gets cited repeatedly across engines?** Those are your real competitors for this territory, and they may not be the same sites that outrank you in Google.
- **What format do the cited pages use?** Match the structural pattern, not the content.
- **Which prompts have no strong incumbent?** That's the opening.
- **Are you cited but described wrongly?** That's an entity clarity problem — fix your About page, bios, and consistent naming.

**Expect lag.** Commonly 4–8 weeks between publishing and appearing in AI answers, and it depends on indexing and domain recognition.

---

## Measurement

**Free and honest:**
- Manual citation audit (above) — the ground truth
- Search Console for the underlying organic health
- Analytics segmented by AI referrer — measure sessions and conversions from `chatgpt.com`, `perplexity.ai`, `gemini.google.com`, etc. This is the clearest business signal available and takes ten minutes to set up.

**Paid, if the user has access:**
- Semrush AI Visibility Toolkit — visibility score, brand performance, prompt tracking, cited pages; Enterprise AIO for scale
- Ahrefs Brand Radar — brand mentions in AI Overviews and generative results
- Otterly, Profound, Scrunch, Rankability, SE Ranking — purpose-built citation and share-of-voice monitoring

Coverage differs by tool and by report. Don't assume any one of them sees all engines.

**Metrics that mean something:**
- Citation rate on your target prompt list
- Share of voice versus named competitors
- AI referral sessions and, more importantly, conversions
- Cited pages — which of your URLs actually get pulled

---

## What not to do

- **Don't write "AI-optimized" content that reads badly to humans.** Every engine is trained on human preference. Content that annoys readers loses.
- **Don't fabricate statistics to hit a density target.** Cite real ones or don't make the claim.
- **Don't abandon SEO for GEO.** They share ~80% of the work and organic still carries far more volume.
- **Don't rely on llms.txt as a strategy.** Google has explicitly said it isn't needed for its generative features. It's cheap to add and harmless; it is not a plan.
- **Don't block AI crawlers by accident.** Check robots.txt. If you're blocking GPTBot, ClaudeBot, or PerplexityBot, you've opted out of citation entirely.
- **Don't treat any number in this file as permanent.** This field is roughly two years old and moving fast.
