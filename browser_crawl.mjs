#!/usr/bin/env node
/**
 * Crawl ulasan Shopee lewat browser sungguhan (Playwright Firefox).
 *
 * Dipakai kalau jalur Python (`python -m crawler.cli`) diblokir anti-bot:
 * Shopee hanya menerima request /api/v2/item/get_ratings yang ditandatangani
 * SDK antifraud di dalam halaman produk, jadi fetch dilakukan dari konteks
 * halaman itu sendiri.
 *
 * Butuh: `npm install` (playwright-core) dan Firefox Playwright yang cocok
 * dengan versi playwright-core:
 *   node node_modules/playwright-core/cli.js install firefox
 *
 * Contoh:
 *   node browser_crawl.mjs --cookies cookies.txt --out raw.json \
 *     --max 500 "https://shopee.co.id/...-i.809769142.22853217492"
 */

import { firefox } from 'playwright-core';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const DOMAIN = 'shopee.co.id';
const INSTALL_HINT = 'node node_modules/playwright-core/cli.js install firefox';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const COOKIE_FILE = arg('cookies');
const OUT = arg('out', 'raw_reviews.json');
const MAX_REVIEWS = Number(arg('max', 500));
const HEADFUL = process.argv.includes('--headful');
const CHECK_ONLY = process.argv.includes('--check');
const FLAGS = ['--cookies', '--out', '--max'];
const urls = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !FLAGS.includes(all[i - 1]));

function loadCookies(path) {
  let raw = readFileSync(path, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // BOM dari Notepad/Windows
  const text = raw.trim();
  if (!text) throw new Error('File cookie kosong: ' + path);

  // Format JSON: {"SPC_F": "...", ...} atau array objek cookie.
  if (text.startsWith('{') || text.startsWith('[')) {
    const data = JSON.parse(text);
    const list = Array.isArray(data)
      ? data
      : Object.entries(data).map(([name, value]) => ({ name, value }));
    const cookies = list.map((c) => ({
      name: String(c.name ?? ''),
      value: String(c.value ?? ''),
      domain: c.domain || ('.' + DOMAIN),
      path: c.path || '/',
      ...(c.secure !== undefined ? { secure: !!c.secure } : {}),
      ...(c.httpOnly !== undefined ? { httpOnly: !!c.httpOnly } : {}),
      ...(Number(c.expires) > 0 ? { expires: Number(c.expires) } : {}),
    })).filter((c) => c.name);
    if (!cookies.length) throw new Error('File cookie tidak berisi cookie yang bisa dipakai.');
    return cookies;
  }

  // Format Netscape (cookies.txt). Baris HttpOnly diawali "#HttpOnly_" dan
  // HARUS tetap dipakai (SPC_U/SPC_SI sering HttpOnly).
  const cookies = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
    .map((line) => line.replace(/^#HttpOnly_/, '').split('\t'))
    .filter((p) => p.length >= 7 && p[5])
    .filter((p) => p[0].replace(/^\./, '').toLowerCase().endsWith(DOMAIN))
    .map(([domain, flag, path, secure, expires, name, value]) => ({
      name,
      value,
      domain,
      path: path || '/',
      secure: secure === 'TRUE',
      httpOnly: flag === 'TRUE',
      ...(Number(expires) > 0 ? { expires: Number(expires) } : {}),
    }));

  if (!cookies.length) {
    throw new Error(
      `File cookie tidak berisi cookie ${DOMAIN}. ` +
      'Ekspor ulang cookies.txt dari browser yang sudah login Shopee.');
  }
  return cookies;
}

function parseRef(text) {
  const m = text.match(/-i\.(\d+)\.(\d+)/) || text.match(/\/product\/(\d+)\/(\d+)/) || text.match(/^(\d+)[.-](\d+)$/);
  if (!m) throw new Error('URL tidak dikenali: ' + text);
  return { shopid: m[1], itemid: m[2] };
}

async function openBrowser() {
  const exe = firefox.executablePath();
  if (!existsSync(exe)) {
    throw new Error(
      'Firefox untuk Playwright belum terpasang (tidak ada: ' + exe + ').\n' +
      'Jalankan di folder proyek:\n  ' + INSTALL_HINT);
  }
  try {
    return await firefox.launchPersistentContext(
      mkdtempSync(join(tmpdir(), 'shopee-crawl-')), {
        headless: !HEADFUL,
        viewport: { width: 1366, height: 900 },
        locale: 'id-ID',
        timezoneId: 'Asia/Jakarta',
      });
  } catch (e) {
    throw new Error(
      'Gagal membuka Firefox: ' + (e?.message || e) + '\n' +
      'Coba jalankan ulang: ' + INSTALL_HINT);
  }
}

async function main() {
  if (CHECK_ONLY) {
    console.log('Node.js         : ' + process.version);
    console.log('Platform        : ' + process.platform + ' ' + process.arch);
    const exe = firefox.executablePath();
    console.log('Firefox         : ' + exe);
    console.log('  terpasang     : ' + (existsSync(exe) ? 'ya' : 'TIDAK -> ' + INSTALL_HINT));
    if (COOKIE_FILE) {
      try {
        const cookies = loadCookies(COOKIE_FILE);
        const names = cookies.map((c) => c.name);
        console.log('File cookie     : ' + COOKIE_FILE);
        console.log('  jumlah cookie : ' + cookies.length);
        console.log('  login Shopee  : ' +
          (names.includes('SPC_U') || names.includes('SPC_F') ? 'ya' : 'tidak (upload ulang cookies.txt)'));
      } catch (e) {
        console.log('File cookie     : ERROR ' + (e?.message || e));
      }
    }
    if (!existsSync(exe)) process.exitCode = 1;
    return;
  }

  if (!COOKIE_FILE || !urls.length) {
    console.error('Pakai: node browser_crawl.mjs --cookies FILE --out FILE [--max N] [--headful] URL...');
    process.exit(1);
  }

  const ctx = await openBrowser();
  await ctx.addCookies(loadCookies(COOKIE_FILE));

  const page = ctx.pages()[0] || (await ctx.newPage());
  page.setDefaultTimeout(60000);
  const results = [];

  for (const raw of urls) {
    const { shopid, itemid } = parseRef(raw);
    const started = Date.now();
    process.stderr.write(`[${itemid}] membuka halaman...\n`);

    let pdp = null;
    let pageRatingsOk = false;
    let pageRatingsError = null;
    const onResponse = async (r) => {
      const u = r.url();
      if (u.includes('pdp/get_pc')) {
        try { pdp = await r.json(); } catch { /* abaikan */ }
      } else if (u.includes('/get_ratings')) {
        try {
          const j = await r.json();
          if (j && j.error) pageRatingsError = j.error;
          else pageRatingsOk = true;
        } catch { /* abaikan */ }
      }
    };
    page.on('response', onResponse);
    try {
      await page.goto(`https://shopee.co.id/product/${shopid}/${itemid}`, { waitUntil: 'domcontentloaded' });
    } catch (e) {
      page.off('response', onResponse);
      process.stderr.write(`[${itemid}] gagal membuka halaman: ${e?.message || e}\n`);
      results.push({ shopid, itemid, error: 'goto: ' + (e?.message || e), reviews: [] });
      continue;
    }

    // Tunggu sampai SDK Shopee menambal window.fetch (penanda: fetch bukan
    // lagi "[native code]") dan/atau halaman selesai memuat data produk.
    const readyStart = Date.now();
    let patched = false;
    while (Date.now() - readyStart < 30000) {
      if (pdp || pageRatingsOk || pageRatingsError) break;
      if (!patched) {
        try {
          patched = await page.evaluate(() => {
            try { return !window.fetch.toString().includes('[native code]'); } catch { return false; }
          });
        } catch { patched = false; }
      }
      if (patched && Date.now() - readyStart > 8000) break;
      await sleep(500);
    }
    page.off('response', onResponse);

    if (page.url().includes('/verify/traffic')) {
      process.stderr.write(`[${itemid}] DIBLOKIR verify/traffic\n`);
      results.push({ shopid, itemid, error: 'verify/traffic', reviews: [] });
      continue;
    }
    if (pageRatingsError && !pdp && !patched) {
      process.stderr.write(`[${itemid}] DIBLOKIR halaman produk ditolak (error ${pageRatingsError})\n`);
      results.push({ shopid, itemid, error: String(pageRatingsError), reviews: [] });
      continue;
    }
    if (!pdp && !patched && !pageRatingsOk) {
      process.stderr.write(`[${itemid}] DIBLOKIR halaman tidak selesai dimuat\n`);
      results.push({ shopid, itemid, error: 'halaman tidak selesai dimuat', reviews: [] });
      continue;
    }

    const limit = 50;
    let offset = 0;
    let reviews = [];
    let total = null;
    let hasMore = true;
    let error = null;
    let retry = 0;

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
        if (batch.error === 90309999 && reviews.length === 0 && retry < 6) {
          retry += 1;
          process.stderr.write(`[${itemid}] menunggu tanda tangan halaman... (${retry}/6)\n`);
          await sleep(2000);
          continue;
        }
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
    if (error) process.stderr.write(`[${itemid}] peringatan: ${error}\n`);
    results.push({ shopid, itemid, info, reviews: kept, total, error, has_more: hasMore });
  }

  writeFileSync(OUT, JSON.stringify(results, null, 1));
  process.stderr.write(`Tersimpan: ${OUT}\n`);
  await ctx.close();
}

main().catch((e) => {
  console.error('ERROR: ' + (e?.message || e));
  process.exit(1);
});
