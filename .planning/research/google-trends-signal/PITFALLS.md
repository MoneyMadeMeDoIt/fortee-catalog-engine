# Pitfalls: Google Trends for Apparel Catalog Curation

**Domain:** Search trend data as popularity proxy
**Researched:** 2026-03-31

## Critical Pitfalls

### Pitfall 1: The Normalization Trap
**What goes wrong:** Google Trends returns 0-100 scaled values relative to the peak WITHIN each query. With 941 styles queried in batches of 5, each batch has its own independent scale. A "75" in batch 1 cannot be compared to a "75" in batch 50.
**Why it happens:** Google Trends is designed for comparing a small set of terms, not ranking hundreds.
**Consequences:** Rankings based on raw Google Trends scores across batches are statistically meaningless. You end up with garbage-in, garbage-out scoring.
**Prevention:** Don't use Google Trends for large-scale ranking. If forced, include an anchor term in every batch and normalize -- but this introduces its own noise from anchor score variability.

### Pitfall 2: Sparse Data for Niche Styles
**What goes wrong:** ~75% of the 941 styles (corporate polos, performance jackets, specialty items from Devon & Jones, Harriton, Core365) return ZERO data from Google Trends. Not "low" -- literally zero.
**Why it happens:** These styles are ordered through B2B channels (distributor catalogs, sales reps) not searched on Google.
**Consequences:** Google Trends effectively becomes a binary signal (has data / doesn't have data) rather than a spectrum. This is equivalent to the hardcoded bestseller list but with 23+ hours of engineering overhead.
**Prevention:** Recognize that Google search behavior does not reflect the B2B apparel purchasing funnel.

### Pitfall 3: Measuring Decorator Interest, Not Consumer Demand
**What goes wrong:** The people searching "Bella Canvas 3001" are screen printers and POD sellers, not end consumers. Google Trends measures decorator/printer popularity, not the downstream demand that drives Fortee's business.
**Why it happens:** End consumers don't know or care about style numbers.
**Consequences:** A style could be heavily searched by decorators (because it's cheap/easy to print on) but be a poor fit for Fortee's premium custom apparel positioning. Or vice versa -- a premium Columbia jacket gets zero searches but is highly demanded by corporate clients.
**Prevention:** Use signals aligned with Fortee's actual customer base (distributor bestseller data, color availability, brand positioning).

## Moderate Pitfalls

### Pitfall 4: False Trend Signals
**What goes wrong:** A style spikes in Google Trends due to controversy (quality complaints, supply chain issues) or meme virality, not actual purchase intent.
**Prevention:** Use 12-month averages, not point-in-time data. But this requires ongoing data collection, increasing maintenance burden.

### Pitfall 5: API Reliability and Maintenance
**What goes wrong:** Unofficial Google Trends access (pytrends, npm libraries) breaks regularly as Google changes endpoints. The primary library (pytrends) was archived in April 2025.
**Prevention:** Use paid scraping APIs (SerpApi, ScrapingBee) -- but this adds ongoing cost for a one-time curation task.

### Pitfall 6: Canada Data Scarcity
**What goes wrong:** Filtering Google Trends to Canada (Fortee's market) dramatically reduces search volume, pushing even more styles below the "insufficient data" threshold.
**Prevention:** Use US data as a proxy, but this introduces geographic bias (US apparel preferences differ from Canadian).

## Minor Pitfalls

### Pitfall 7: Seasonal Bias
**What goes wrong:** T-shirts trend higher in spring/summer; hoodies in fall/winter. A snapshot query bakes in seasonal bias.
**Prevention:** Query 12-month rolling data. Adds complexity but solvable.

### Pitfall 8: Brand Name Ambiguity
**What goes wrong:** Searching "Columbia jacket" returns results for Columbia Sportswear's retail line, not the wholesale blank jacket Fortee sells.
**Prevention:** Use brand + exact style number. But this circles back to the sparse data problem for most styles.
