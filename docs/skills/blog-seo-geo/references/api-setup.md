# API Setup & Data Providers

---

## Security first

**Never ask the user to paste an API key into a chat window, and never write one into a script or a committed file.** Keys grant access to paid balances and account data; an exposed key can mean unexpected charges.

Correct pattern — the user runs this in their own shell:

```bash
export SEMRUSH_API_KEY="..."          # session only
```

Or persists it in their shell profile (`~/.zshrc`, `~/.bashrc`) or a `.env` file that is gitignored:

```bash
echo 'export SEMRUSH_API_KEY="..."' >> ~/.zshrc && source ~/.zshrc
```

If a key ever appears in the conversation, tell the user plainly to rotate it.

---

## Semrush

**Getting a key.** API access requires a paid plan. The key lives in Semrush under **Subscription info → API units**. Standard API and Trends API are separate subscriptions with separate access.

**Environment variable:** `SEMRUSH_API_KEY`

**Endpoint:** `https://api.semrush.com/` — GET requests, responses are **semicolon-delimited CSV** (not JSON).

**Unit economics — the thing to actually understand.** Semrush does not charge per request. It charges **per returned line**, and the rate varies by report:

| Report | Type | Units/line |
|---|---|---|
| Keyword overview | `phrase_this` | 10 |
| Related keywords | `phrase_related` | 10 |
| Question keywords | `phrase_questions` | 10 |
| Broad match | `phrase_fullsearch` | 10 |
| Keyword difficulty | `phrase_kdi` | 10 |
| Domain organic keywords | `domain_organic` | 10 (50 historical) |
| URL organic keywords | `url_organic` | 10 |
| Keyword gap | `domain_domains` | 20 |
| Organic competitors | `domain_organic_organic` | 40 |

At roughly $0.00005/unit list pricing (~$50 per million), 1,000 keywords for one domain on live data costs ~10,000 units. Pulling 1,000 keywords across 100 competitor domains is ~1,000,000 units — around $50 for one analysis, and 5× that on historical data.

**Therefore:**
- `display_limit` is the cost lever. Default it low.
- Empty responses cost nothing.
- You're only charged for lines actually returned.
- **Unused units do not roll over.** They reset each billing cycle.
- Run `scripts/semrush.py cost <report> --limit N` before any large pull, and tell the user the estimate.
- Check the balance with `scripts/semrush.py balance`.

**Filtering syntax** (`display_filter`) — this is where most of the savings are, because filtering server-side means fewer returned lines:

```
+|Nq|Gt|1000        volume greater than 1000
+|Kd|Lt|40          difficulty less than 40
+|Co|Lt|0.6         paid competition below 0.6
-|Ph|Co|free        exclude keywords containing "free"
```

Joined with `|`. Operators: `Gt`, `Lt`, `Eq`, `Co` (contains), `Bw` (begins with), `Ew` (ends with). Leading `+` includes, `-` excludes.

**Column codes** worth knowing: `Ph` keyword · `Nq` volume · `Cp` CPC · `Co` competition · `Kd` difficulty · `In` intent · `Nr` results count · `Td` trend · `Po` position · `Ur` URL · `Tr` traffic share.

**Keyword gap `domains` syntax** is unusual — `<sign>|<type>|<domain>` joined by `|`, where `*` = must rank, `+` = may rank, `-` = must not rank. So competitors get `*`/`+` and your own domain gets `-`. `scripts/semrush.py gap` builds this for you.

**AI visibility.** Semrush's AI Visibility Toolkit (visibility score, brand performance, prompt tracking, cited pages) and Enterprise AIO are largely UI/enterprise products rather than open API endpoints. What *is* accessible via API: the Projects/Position Tracking endpoints support `serp_feature_filter=aio` to pull keywords where your tracked domain appears in Google AI Overviews. That requires an existing Position Tracking campaign. For everything else GEO-related, the manual citation audit in `references/geo.md` is free and often more informative.

---

## Other providers

### Ahrefs
- API access is a paid add-on on higher plans; historically more restricted than Semrush's.
- **Ahrefs Webmaster Tools is free** for verified sites and gives backlink and keyword data for your own domain — a genuinely good free option.
- **Brand Radar** tracks brand mentions in AI Overviews and generative results.
- Env var convention: `AHREFS_API_TOKEN`

### DataForSEO
- Usually the cheapest per-request option and the most flexible: SERP data, keyword data, on-page, backlinks, and Google AI Overview / AI Mode results.
- Pay-as-you-go rather than subscription. Worth suggesting when the user balks at Semrush pricing.
- Env var: `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` (basic auth).

### Google Search Console API
- **Free.** The most honest data available for a site the user owns — actual queries, impressions, positions, clicks.
- Requires OAuth setup via Google Cloud Console.
- **If the user owns the site, start here before anything paid.** The fastest wins in SEO are usually already in the Queries report: terms with impressions and a mediocre position.

### Google Trends
- Free, no key. Direction and seasonality, not absolute volume. Useful for deciding whether a topic is rising or dying.

### Serper / SerpApi / ValueSERP
- Cheap SERP-scraping APIs. Useful for the SERP-overlap test at scale, and for programmatically checking what format Google has chosen for a query.

### GEO/citation monitoring
Otterly, Profound, Scrunch, Rankability, SE Ranking. Coverage differs by tool — none sees every engine. For most users the free monthly manual audit is sufficient and more informative.

---

## Adding a new provider to this skill

If the user has a provider not covered here, write a script in `scripts/` following the pattern in `semrush.py`:

1. Read the key from an environment variable, never an argument
2. Subcommands matching real research tasks, not raw endpoint names
3. Cost estimation and `--dry-run` before anything metered
4. Normalize output to a table and optional `--json` / `--csv`
5. Fail with an actionable message when the key is missing, including a pointer to the no-tools workflow

---

## When there's no API at all

This is common and fine. `references/keyword-research.md` has the full free workflow: autocomplete, People Also Ask, related searches, Search Console, Trends, competitor sitemaps, and community platforms.

**The free path produces better intent reading than the API path,** because you end up actually looking at search results instead of a difficulty number. Slower, not worse.
