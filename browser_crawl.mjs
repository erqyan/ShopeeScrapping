#!/usr/bin/env node
/**
 * Crawl ulasan Shopee lewat browser sungguhan (Playwright Firefox).
 *
 * Dipakai kalau jalur Python (`python -m crawler.cli`) diblokir anti-bot:
 * Shopee hanya menerima request /api/v2/item/get_ratings yang ditandatangani
 * SDK antifraud di dalam halaman produk, jadi fetch dilakukan dari konteks
 * halaman itu sendiri.
 *
 * Butuh: `npm install` (playwright-core) dan browser Firefox Playwright
 * (`npx playwright install firefox`).
 *
 * Contoh:
 *   node browser_crawl.mjs --cookies cookies.txt --out raw.json \
 *     --max 500 "https://shopee.co.id/...-i.809769142.22853217492"
 */

import { firefox } from 'playwright-core';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const COOKIE_FILE = arg('cookies');
const OUT = arg('out', 'raw_reviews.json');
const MAX_REVIEWS = Number(arg('max', 500));
const HEADFUL = process.argv.includes('--headful');
const FLAGS = ['--cookies', '--out', '--max'];
const urls = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !FLAGS.includes(all[i - 1]));

if (!COOKIE_FILE || !urls.length) {
  console.error('Pakai: node browser_crawl.mjs --cookies FILE --out FILE [--max N] URL...');
  process.exit(1);
}

const DOMAIN = 'shopee.co.id';

function loadCookies(path) {
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.startsWith('{')) {
    return Object.entries(JSON.parse(raw)).map(([name, value]) => ({ name, value, domain: '.' + DOMAIN, path: '/' }));
  }
  return raw.split('\n')
    .map((l) => l.trim().split('\t'))
    .filter((p) => p.length >= 7 && !p[0].startsWith('#') && p[0].replace(/^\./, '').endsWith(DOMAIN))
    .map(([domain, flag, path, secure, expires, name, value]) => ({
      name, value, domain, path: path || '/', secure: secure === 'TRUE', httpOnly: flag === 'TRUE',
      ...(Number(expires) > 0 ? { expires: Number(expires) } : {}),
    }));
}

function parseRef(text) {
  const m = text.match(/-i\.(\d+)\.(\d+)/) || text.match(/\/product\/(\d+)\/(\d+)/) || text.match(/^(\d+)[.-](\d+)$/);
  if (!m) throw new Error('URL tidak dikenali: ' + text);
  return { shopid: m[1], itemid: m[2] };
}

const profile = mkdtempSync(join(tmpdir(), 'shopee-crawl-'));
const ctx = await firefox.launchPersistentContext(profile, {
  headless: !HEADFUL,
  viewport: { width: 1366, height: 900 },
  locale: 'id-ID',
  timezoneId: 'Asia/Jakarta',
});
await ctx.addCookies(loadCookies(COOKIE_FILE));

const page = ctx.pages()[0] || (await ctx.newPage());
page.setDefaultTimeout(60000);
const results = [];

for (const raw of urls) {
  const { shopid, itemid } = parseRef(raw);
  const started = Date.now();
  process.stderr.write(`[${itemid}] membuka halaman...\n`);

  let pdp = null;
  const onResponse = async (r) => {
    if (r.url().includes('pdp/get_pc')) {
      try { pdp = await r.json(); } catch { /* abaikan */ }
    }
  };
  page.on('response', onResponse);
  await page.goto(`https://shopee.co.id/product/${shopid}/${itemid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  page.off('response', onResponse);

  if (page.url().includes('/verify/traffic')) {
    process.stderr.write(`[${itemid}] DIBLOKIR verify/traffic\n`);
    results.push({ shopid, itemid, error: 'verify/traffic', reviews: [] });
    continue;
  }

  const limit = 50;
  let offset = 0;
  let reviews = [];
  let total = null;
  let hasMore = true;
  let error = null;

  while (reviews.length < MAX_REVIEWS && hasMore) {
    const batch = await page.evaluate(async ({ itemid, shopid, offset, limit }) => {
      const url = `/api/v2/item/get_ratings?filter=0&flag=1&itemid=${itemid}&limit=${limit}&offset=${offset}&shopid=${shopid}&type=0`;
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) return { http: r.status };
      const j = await r.json();
      if (j.error) return { error: j.error };
      const d = j.data || {};
      return {
        ratings: d.ratings || [],
        has_more: d.has_more ?? false,
        total: d.item_rating_count ?? null,
      };
    }, { itemid, shopid, offset, limit });

    if (batch.http || batch.error) {
      error = batch.http ? 'HTTP ' + batch.http : 'error ' + batch.error;
      break;
    }
    if (offset === 0) total = batch.total;
    reviews.push(...batch.ratings);
    offset += limit;
    hasMore = !!batch.has_more && batch.ratings.length === limit;
    process.stderr.write(`[${itemid}] ${Math.min(reviews.length, MAX_REVIEWS)}/${total ?? '?'} rating\n`);
    if (total !== null && offset >= total) break;
    if (hasMore) await sleep(250);
  }

  const review = pdp?.data?.product_review || {};
  const item = pdp?.data?.item || {};
  const shop = pdp?.data?.shop_detailed || {};
  const info = {
    shopid,
    itemid,
    product_name: item.title ?? null,
    shop_name: shop.account?.username ?? null,
    shop_rating: shop.rating_star ?? null,
    sold: review.historical_sold ?? item.sold ?? null,
    rating_star: review.rating_star ?? null,
    rating_count: review.rating_count ?? null,
    cmt_count: review.cmt_count ?? null,
    is_official_shop: shop.is_official_shop ?? null,
  };

  const kept = reviews.slice(0, MAX_REVIEWS);
  process.stderr.write(`[${itemid}] selesai ${kept.length} rating (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
  results.push({ shopid, itemid, info, reviews: kept, total, error, has_more: hasMore });
}

writeFileSync(OUT, JSON.stringify(results, null, 1));
process.stderr.write(`Tersimpan: ${OUT}\n`);
await ctx.close();
