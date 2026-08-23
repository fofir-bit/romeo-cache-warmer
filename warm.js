'use strict';

/*
 * Romeo Gifts — external cache warmer.
 * Reads the site's XML sitemap(s) and requests each URL so Cloudflare + Varnish
 * cache them. Because it runs externally (through Cloudflare), it warms the EDGE,
 * which a server-side WordPress preloader cannot do.
 *
 * v2 (Aug 2026) — also warms VARIATION URLs.
 *   The sitemap contains only parent product pages. Every paid click from Google
 *   Shopping and Meta lands on a variation URL like:
 *     /product/<slug>/?attribute_pa_brachon-design=birkon-2
 *   Those are never in the sitemap, so before this change they were always cold.
 *   Measured on 21/08/2026: cold variation = 6533ms (cf DYNAMIC),
 *   same URL right after = 1332ms (cf HIT). ~4.9x.
 *
 *   The list is built from the WooCommerce Store API, which is PUBLIC — no
 *   consumer key/secret needed, so nothing has to be stored in GitHub secrets:
 *     /wp-json/wc/store/v1/products?type=variable&per_page=100&page=N
 *   Each product gives us `permalink`, its `attributes[].taxonomy`, and
 *   `variations[].attributes[]`. That is exactly what WooCommerce itself uses to
 *   build a variation permalink, so the URLs match the ones in the ad catalogs.
 *
 * No dependencies. Requires Node 18+ (built-in fetch).
 * Configurable via env vars (see below), all optional.
 */

const SITE = (process.env.SITE_URL || 'https://romeo-gifts.co.il').replace(/\/+$/, '');
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || '3', 10)); // keep low to be gentle on the origin
const DELAY_MS = parseInt(process.env.DELAY_MS || '250', 10); // pause between requests per worker
const REQ_TIMEOUT_MS = parseInt(process.env.REQ_TIMEOUT_MS || '30000', 10); // abort a stuck request
const VERIFY = (process.env.VERIFY || 'true') !== 'false'; // do a 2nd pass to confirm HIT rate
const WARM_VARIATIONS = (process.env.WARM_VARIATIONS || 'true') !== 'false'; // v2: warm variation URLs too
const UA = process.env.USER_AGENT || 'Mozilla/5.0 (compatible; RomeoCacheWarmer/2.0; +sitemap warmer)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function timedFetch(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, cf: res.headers.get('cf-cache-status') || '-', body };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, cf: 'ERR', error: String((e && e.name) || e), body: '' };
  } finally {
    clearTimeout(timer);
  }
}

const extractLocs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].trim());

async function collectUrls() {
  const urls = new Set();
  let subSitemaps = [];
  for (const p of ['/sitemap_index.xml', '/sitemap.xml', '/product-sitemap.xml']) {
    const r = await timedFetch(SITE + p);
    if (r.ok && r.body.includes('<loc>')) {
      const locs = extractLocs(r.body);
      if (r.body.includes('<sitemapindex')) subSitemaps = locs; // it's an index of sub-sitemaps
      else locs.forEach((u) => urls.add(u)); // it's a flat list of pages
      break;
    }
  }
  for (const sm of subSitemaps) {
    const r = await timedFetch(sm);
    if (r.ok) extractLocs(r.body).forEach((u) => { if (!/\.xml(\.gz)?$/i.test(u)) urls.add(u); });
  }
  urls.add(SITE + '/'); // always include the homepage
  return [...urls];
}

/*
 * v2 — variation URLs.
 * Never throws: if the Store API is unreachable or changes shape we log and
 * return [], so a warm run degrades to v1 behaviour instead of failing.
 */
async function collectVariationUrls() {
  const urls = new Set();
  let page = 1;
  let pages = 1;
  let products = 0;

  while (page <= pages && page <= 20) { // hard stop, the catalog is ~50 variable products
    const api = `${SITE}/wp-json/wc/store/v1/products?type=variable&per_page=100&page=${page}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
    let batch;
    try {
      const res = await fetch(api, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
      if (!res.ok) { console.warn(`[variations] Store API returned ${res.status} on page ${page} — skipping variation warming.`); return [...urls]; }
      const tp = parseInt(res.headers.get('x-wp-totalpages') || '1', 10);
      if (Number.isFinite(tp) && tp > 0) pages = tp;
      batch = await res.json();
    } catch (e) {
      console.warn(`[variations] Store API request failed (${String((e && e.name) || e)}) — skipping variation warming.`);
      return [...urls];
    } finally {
      clearTimeout(timer);
    }

    if (!Array.isArray(batch) || !batch.length) break;

    for (const p of batch) {
      if (!p || !p.permalink || !Array.isArray(p.variations)) continue;
      products++;

      // attribute display name -> taxonomy slug (e.g. "צבע" -> "pa_color")
      const taxByName = {};
      for (const a of p.attributes || []) if (a && a.name) taxByName[a.name] = a.taxonomy || '';

      for (const v of p.variations) {
        const parts = [];
        for (const a of (v && v.attributes) || []) {
          if (!a || !a.value) continue; // "any <attribute>" variations have no fixed value — WooCommerce omits them too
          const key = taxByName[a.name] || String(a.name).toLowerCase().replace(/\s+/g, '-');
          parts.push(`attribute_${key}=${encodeURIComponent(a.value)}`);
        }
        if (!parts.length) continue; // nothing to distinguish it from the parent page
        // p.permalink is already correctly encoded by WooCommerce — do not re-encode it,
        // that is what caused the double-encoding bug back in July.
        urls.add(`${p.permalink}${p.permalink.includes('?') ? '&' : '?'}${parts.join('&')}`);
      }
    }
    page++;
  }

  console.log(`[variations] ${products} variable products -> ${urls.size} variation URLs`);
  return [...urls];
}

async function pass(name, items) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const my = idx++;
      const it = items[my];
      const r = await timedFetch(it.url);
      results.push({ url: it.url, group: it.group, status: r.status, ms: r.ms, cf: r.cf, error: r.error });
      const tag = r.cf === 'HIT' ? 'HIT ' : r.cf === 'ERR' ? 'ERR ' : 'MISS';
      console.log(`[${name}] [${String(my + 1).padStart(3)}/${items.length}] ${it.group === 'variation' ? 'VAR ' : 'PAGE'} ${tag} ${r.status} ${String(r.ms).padStart(5)}ms ${it.url}`);
      if (DELAY_MS) await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

function summarize(label, results) {
  const hit = results.filter((r) => r.cf === 'HIT').length;
  const miss = results.filter((r) => r.cf !== 'HIT' && r.cf !== 'ERR').length;
  const err = results.filter((r) => r.cf === 'ERR').length;
  const slow = results.filter((r) => r.ms > 2000).length;
  const avg = Math.round(results.reduce((a, r) => a + r.ms, 0) / (results.length || 1));
  console.log(`---- ${label}: total=${results.length} HIT=${hit} MISS/DYNAMIC=${miss} ERR=${err} slow(>2s)=${slow} avg=${avg}ms`);
  if (err) results.filter((r) => r.cf === 'ERR').slice(0, 15).forEach((r) => console.log(`     ERR ${r.url} -> ${r.error}`));
  return { hit, miss, err, slow, avg, total: results.length };
}

function summarizeByGroup(results) {
  for (const g of ['sitemap', 'variation']) {
    const sub = results.filter((r) => r.group === g);
    if (sub.length) summarize(g === 'variation' ? '  variation URLs' : '  sitemap URLs', sub);
  }
}

(async () => {
  console.log(`Cache warm start ${new Date().toISOString()} -> ${SITE} (concurrency=${CONCURRENCY}, variations=${WARM_VARIATIONS})`);

  const sitemapUrls = await collectUrls();
  console.log(`Discovered ${sitemapUrls.length} sitemap URLs`);
  if (!sitemapUrls.length) { console.error('No URLs found in sitemap. Check SITE_URL.'); process.exit(1); }

  const variationUrls = WARM_VARIATIONS ? await collectVariationUrls() : [];

  const seen = new Set(sitemapUrls);
  const items = [
    ...sitemapUrls.map((url) => ({ url, group: 'sitemap' })),
    ...variationUrls.filter((u) => !seen.has(u)).map((url) => ({ url, group: 'variation' })),
  ];
  console.log(`Warming ${items.length} URLs total (${sitemapUrls.length} sitemap + ${items.length - sitemapUrls.length} variation)\n`);

  const warm = await pass('warm', items);
  summarize('warm pass', warm);
  summarizeByGroup(warm);

  let stats = summarize('result', warm);
  if (VERIFY) {
    await sleep(1500);
    const verify = await pass('verify', items);
    stats = summarize('verify pass (the real result)', verify);
    summarizeByGroup(verify);
    console.log(`\n✅ After warming: ${stats.hit}/${stats.total} pages now served from cache (HIT). Slow(>2s): ${stats.slow}.`);
  }

  if (stats.err / (stats.total || 1) > 0.2) { console.error(`Too many errors (${stats.err}/${stats.total}).`); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
