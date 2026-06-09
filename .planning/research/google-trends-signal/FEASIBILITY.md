# Feasibility Assessment: Google Trends as Popularity Signal for Apparel Catalog Curation

**Verdict:** NO -- not worth implementing
**Confidence:** HIGH

## 1. Google Trends API/Access Landscape

### Official Google Trends API (Alpha)
- **Launched:** July 2025
- **Status:** Alpha, waitlist-only access. Google is accepting applications but onboarding is slow (started mid-September 2025, "very limited number of testers").
- **Requirements:** Google Cloud account, OAuth 2.0, must articulate a specific use case in application.
- **Data format:** NOT scaled 0-100 (unlike the web UI) -- provides raw interest values. Rolling 5-year window (~1,800 days). Supports country and sub-region filtering (Canada would work).
- **Verdict:** Not accessible for Fortee's use case. Application would likely be rejected (filtering a 941-item catalog is not the "research/journalism/content platform" use case Google is prioritizing).

Sources:
- [Google Trends API Alpha Documentation](https://developers.google.com/search/apis/trends)
- [Google Trends API Announcement (July 2025)](https://developers.google.com/search/blog/2025/07/trends-api)

### pytrends (Unofficial Python Library)
- **Status:** ARCHIVED by owner (GeneralMills) on April 17, 2025. Read-only repository. No further maintenance.
- **Reliability before archival:** Plagued by 429 (Too Many Requests) errors. Users reported being rate-limited after ~1,400 requests. Workarounds required 60-second delays between requests, proxy rotation, or CAPTCHA-solving cookies.
- **For 941 styles:** At 60s delay per request, that is ~16 hours of runtime for a single pass. With failures and retries, realistically 24+ hours.
- **Forks:** `pytrends-modern` and `pytrends-async` exist with better retry/backoff logic, but they are thin wrappers around the same unofficial endpoints that Google actively throttles.

Sources:
- [pytrends GitHub (archived)](https://github.com/GeneralMills/pytrends)
- [pytrends rate limit discussion](https://github.com/GeneralMills/pytrends/issues/523)

### Node.js Options
- **google-trends-api (npm):** Pat310's library. Still available but uses the same unofficial endpoints as pytrends. Subject to identical rate limiting. Last meaningful update was years ago.
- **@alkalisummer/google-trends-js:** TypeScript wrapper, updated more recently but same underlying endpoints.
- **Verdict:** Same reliability problems as pytrends. Not a viable path.

Source:
- [google-trends-api on npm](https://www.npmjs.com/package/google-trends-api)

### Paid Scraping APIs
| Service | Price | Searches/month | Per-search cost |
|---------|-------|----------------|-----------------|
| SerpApi | $75/mo | 5,000 | $0.015 |
| SerpApi (Production) | $150/mo | 15,000 | $0.010 |
| ScrapingBee | Varies | Varies | ~$0.01 |
| Scrapeless (Growth) | $49/mo | Varies | Varies |

For 941 styles, you need ~200 API calls (5 terms per comparison batch). At $0.015/call that is $3 -- cheap in isolation, but requires ongoing subscription and code maintenance for a one-time curation task.

Sources:
- [SerpApi Google Trends API](https://serpapi.com/blog/scraping-google-trends-with-python-pytrends-alternative/)
- [ScrapingBee Google Trends APIs 2026](https://www.scrapingbee.com/blog/best-google-trends-api/)

---

## 2. Signal Quality Analysis

### Do People Search for Style Numbers?

**Yes, but only in the B2B/decorator context.** The search results confirm that terms like "Bella Canvas 3001", "Gildan 18500", "Gildan 64000", and "Next Level 3600" are actively searched. However, the searchers are:
- Screen printers comparing blanks
- Print-on-demand sellers choosing base garments
- Wholesale buyers looking up specifications

These are NOT end consumers. End consumers search for "soft black t-shirt" or "heavyweight hoodie", not "Gildan 18500".

### Search Term Options Analysis

| Search term format | Example | Signal quality | Problem |
|---|---|---|---|
| Brand + style number | "Bella Canvas 3001" | MODERATE for top 20 styles, ZERO for rest | Only bestsellers have volume |
| Brand + product name | "Bella Canvas Jersey Tee" | LOW | Too generic, matches non-blank results |
| Style number alone | "3001" | USELESS | Matches thousands of unrelated things |
| Brand alone | "Bella Canvas" | USELESS for style ranking | Measures brand, not style popularity |

### Expected Distribution

Based on industry knowledge and search behavior:

| Tier | Styles | Expected Google Trends signal |
|------|--------|-------------------------------|
| Top 10 bestsellers (BC 3001, G 18500, NL 3600, G 5000, BC 3413, etc.) | ~10 | STRONG -- meaningful relative interest |
| Well-known styles | ~20-30 | WEAK -- some signal but noisy |
| Mid-catalog styles | ~200 | NEAR ZERO -- insufficient data for Google Trends |
| Long-tail / niche styles (Devon & Jones, Harriton, Core365) | ~700 | ZERO -- Google Trends returns "not enough data" |

**This means Google Trends can only differentiate the top ~30 styles, which are ALREADY KNOWN bestsellers.** The signal adds no value where it matters most: differentiating the 700+ mid-to-low-tier styles.

### Canada-Specific Concerns

Fortee is Canadian. Google Trends data for Canada will have even LESS volume than US data for niche style numbers. Many style searches happen in the US market; Canadian search volume for "Bella Canvas 3001" would likely be insufficient for stable trend data outside the top 5-10 styles.

---

## 3. The Normalization Problem

Google Trends (web UI) returns values scaled 0-100 relative to the peak within each query. You can compare at most 5 terms per query.

**941 styles / 5 per batch = 188 batches**

Each batch is independently scaled. A score of 80 in batch 1 means something completely different than 80 in batch 47. To normalize:

1. Include a "reference term" in every batch (e.g., "Bella Canvas 3001" as the anchor).
2. Scale all other terms relative to the anchor's score across batches.

**Problems with this approach:**
- The anchor itself fluctuates by time of day, day of week, and random sampling.
- Most terms in most batches will return 0 (insufficient data), making the normalization pointless.
- Even with the official API (which uses raw values instead of 0-100), cross-query comparisons require careful statistical treatment that is non-trivial to implement correctly.

---

## 4. Alternative Popularity Signals

### Already in the scoring model (from CATALOG-CURATION-REPORT.md):
- Color count (weight 3.0) -- strong proxy for popularity
- Size range (weight 2.5)
- Stock reliability (weight 2.0) -- distributors stock what sells
- Fit modernity (weight 1.5)
- Trend alignment (weight 1.0)

### Better alternatives to Google Trends:

| Signal | Cost | Effort | Quality |
|--------|------|--------|---------|
| **Expanded hardcoded bestseller list** | Free | 2 hours of research | HIGH -- based on industry consensus |
| **S&S/SanMar "top seller" badges** | Free (in existing data) | 1 hour to parse | HIGH -- reflects actual wholesale volume |
| **Distributor page ranking** | Free (scrape once) | 4 hours | MEDIUM -- reflects merchandising decisions |
| **Amazon bestseller rank for equivalent products** | Free (scrape) | 8 hours | MEDIUM -- different market but correlated |
| **Google Keyword Planner (via Google Ads)** | Needs $100/mo ad spend | 4 hours | MEDIUM -- actual search volumes, not relative |
| **Google Trends via SerpApi** | $75/mo | 8-12 hours | LOW -- normalization problems, sparse data |

### Recommendation: Expanded Bestseller List

The highest-ROI improvement is simply expanding the hardcoded bestseller list. Publicly available sources for this:

1. **S&S Activewear "Best Sellers" filter** -- shows top sellers by category
2. **SanMar "Top Sellers"** -- same
3. **alphabroder trending styles** -- same
4. **Multiple "best blank tee" comparison articles** consistently cite the same ~30 styles

These sources converge on a consensus list that is more accurate than Google Trends data would be, requires no API integration, and takes 2 hours of manual research.

---

## 5. Cost-Benefit Analysis

### Engineering effort for Google Trends integration:
- Research and select API approach: 2 hours (done)
- Implement scraping/API client with retry logic: 8 hours
- Implement normalization across batches: 4 hours
- Test and validate results: 4 hours
- Handle Canada geo-filtering: 1 hour
- Debug rate limiting / 429 errors: 4 hours (minimum)
- **Total: ~23 hours of engineering**

### Expected outcome:
- Would correctly identify the top 20-30 styles (already known)
- Would return zero data for ~700 styles (useless)
- Would return noisy, unreliable data for ~200 mid-tier styles
- Net effect on final ranking: marginal reordering of mid-tier styles with LOW confidence

### Risks:
- **False positives:** A style trending because of a recall, controversy, or meme (not actual demand)
- **False negatives:** Excellent new styles with no search history yet
- **Temporal bias:** Seasonal spikes could inflate summer tees in summer, hoodies in winter
- **Maintenance burden:** Unofficial endpoints break regularly; official API may change in alpha

### Verdict: Engineering effort (23+ hours) vastly exceeds value (marginal improvement over free alternatives)

---

## 6. Final Recommendation

**Do NOT integrate Google Trends.** Instead:

1. **Expand the hardcoded bestseller list to ~30 styles** using distributor "top seller" pages and industry comparison articles. Apply a `popularityBonus` of +10 to +15 points in the scoring formula.

2. **Extract "top seller" / "featured" flags from distributor data** if available in the S&S/SanMar product feeds. These reflect actual wholesale purchase volume and are a far superior signal.

3. **Revisit search-based signals only when** Fortee has actual sales data (even 60 days of Shopify analytics would be more valuable than any Google Trends data).

---

## Sources

- [Google Trends API Alpha](https://developers.google.com/search/apis/trends) -- Official documentation, alpha access only
- [Google Trends API Announcement](https://developers.google.com/search/blog/2025/07/trends-api) -- July 2025 launch blog post
- [pytrends GitHub (archived)](https://github.com/GeneralMills/pytrends) -- Archived April 2025
- [pytrends rate limit issues](https://github.com/GeneralMills/pytrends/issues/523) -- Persistent 429 errors
- [google-trends-api npm](https://www.npmjs.com/package/google-trends-api) -- Node.js alternative
- [SerpApi Google Trends](https://serpapi.com/blog/scraping-google-trends-with-python-pytrends-alternative/) -- Paid alternative
- [ScrapingBee Google Trends APIs](https://www.scrapingbee.com/blog/best-google-trends-api/) -- 2026 comparison
- [Google Trends FAQ](https://support.google.com/trends/answer/4365533?hl=en) -- Data methodology
- [VeeTrends NL 3600 vs BC 3001](https://www.veetrends.com/blog/comprehensive-breakdown-next-level-3600-vs-bella-canvas-3001-comparison) -- Style comparison showing search behavior
- [Real Thread BC 3001 vs G 5000](https://www.realthread.com/blog/bella-canvas-3001-vs-gildan-5000) -- Style comparison
- [S&S Activewear Gildan 18500](https://www.ssactivewear.com/p/gildan/18500) -- Distributor listing showing top seller status
