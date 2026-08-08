# Content skills (reference docs)

Operator playbooks Yoinky generation prompts are grounded in. These are **reference material** for humans and for prompt engineering — not loaded automatically at runtime.

| Skill | Path | Used for |
|-------|------|----------|
| X copywriting | [`x-copywriting/SKILL.md`](./x-copywriting/SKILL.md) | Tweet / X posts, threads, reach principles |
| LinkedIn (Lara method) | [`linkedin-lara-method/SKILL.md`](./linkedin-lara-method/SKILL.md) | LinkedIn posts — SMPV, SLAY, hooks, formatting |
| Newsletter | [`substack-newsletter/SKILL.md`](./substack-newsletter/SKILL.md) | Newsletter sections, issue structure |
| Blog SEO / GEO | [`blog-seo-geo/SKILL.md`](./blog-seo-geo/SKILL.md) | Blog outlines, answer-first GEO, keyword research |

## Semrush / SEO research

Blog SEO scripts (e.g. `blog-seo-geo/scripts/semrush.py`) need a Semrush API key:

```bash
SEMRUSH_API_KEY=          # primary — set this even if provisioned via Mond AI
#MOND_AI_API_KEY=         # optional alias; prefer SEMRUSH_API_KEY
```

**Remind:** set `SEMRUSH_API_KEY` when enabling blog SEO/GEO research.
