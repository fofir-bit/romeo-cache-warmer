'use strict';

/*
 * Romeo Gifts — external cache warmer.
 * Reads the site's XML sitemap(s) and requests each URL so Cloudflare + Varnish
 * cache them. Because it runs externally (through Cloudflare), it warms the EDGE,
 * which a server-side WordPress preloader cannot do.
 *
 * No dependencies. Requires Node 18+ (built-in fetch).
 * Configurable via env vars (see below), all optional.
 */

const SITE = (process.env.SITE_URL || 'https://romeo-gifts.co.il').replace(/\/+$/, '');
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || '3', 10)); // keep low to be gentle on the origin
const DELAY_MS = parseInt(process.env.DELAY_MS || '250', 10);                  // pause between requests per worker
const REQ_TIMEOUT_MS = parseInt(process.env.REQ_TIMEOUT_MS || '30000', 10);    // abort a stuck request
const VERIFY = (process.env.VERIFY || 'true') !== 'false';                     // do a 2nd pass to confirm HIT rate
const UA = process.env.USER_AGENT || 'Mozilla/5.0 (compatible; RomeoCacheWarmer/1.0; +sitemap warmer)';

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
      else locs.forEach((u) => urls.add(u));                    // it's a flat list of pages
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

async function pass(name, urls) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < urls.length) {
      const my = idx++;
      const r = await timedFetch(urls[my]);
      results.push({ url: urls[my], status: r.status, ms: r.ms, cf: r.cf, error: r.error });
      const tag = r.cf === 'HIT' ? 'HIT ' : r.cf === 'ERR' ? 'ERR ' : 'MISS';
      console.log(`[${name}] [${String(my + 1).padStart(3)}/${urls.length}] ${tag} ${r.status} ${String(r.ms).padStart(5)}ms  ${urls[my]}`);
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

(async () => {
  console.log(`Cache warm start ${new Date().toISOString()} -> ${SITE} (concurrency=${CONCURRENCY})`);
  const urls = await collectUrls();
  console.log(`Discovered ${urls.length} URLs\n`);
  if (!urls.length) { console.error('No URLs found in sitemap. Check SITE_URL.'); process.exit(1); }

  const warm = await pass('warm', urls);
  summarize('warm pass', warm);

  let stats = summarize('result', warm);
  if (VERIFY) {
    await sleep(1500);
    const verify = await pass('verify', urls);
    stats = summarize('verify pass (the real result)', verify);
    console.log(`\n✅ After warming: ${stats.hit}/${stats.total} pages now served from cache (HIT). Slow(>2s): ${stats.slow}.`);
  }

  if (stats.err / (stats.total || 1) > 0.2) { console.error(`Too many errors (${stats.err}/${stats.total}).`); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
