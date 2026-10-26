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
const DIAGNOSE = process.argv.includes('--diagnose');
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

function maskValue(v) {
  const s = String(v || '');
  return s.length <= 6 ? '(pendek)' : s.slice(0, 4) + '…' + s.slice(-2);
}

function maskIp(ip) {
  if (!ip) return '(tidak diketahui)';
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':') + '::…';
  const p = ip.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.x.x` : ip;
}

async function diagnose() {
  const { shopid, itemid } = parseRef(urls[0]);
  const out = (...a) => console.log(...a);
  out('== Diagnosa sesi Shopee ==');
  out('Sistem        : ' + process.platform + ' ' + process.arch + ' | Node ' + process.version);
  out('Mode browser  : ' + (HEADFUL ? 'tampil (headful)' : 'tersembunyi (headless)'));
  out('Produk uji    : ' + shopid + '.' + itemid);

  const cookies = loadCookies(COOKIE_FILE);
  const names = cookies.map((c) => c.name);
  const keys = ['SPC_U', 'SPC_F', 'SPC_SI', 'SPC_T', 'csrftoken', 'SPC_CDS'];
  out('Cookie        : ' + cookies.length + ' butir | ' + keys.filter((k) => names.includes(k)).join(', '));
  const spcU = cookies.find((c) => c.name === 'SPC_U');
  if (spcU) out('  SPC_U       : ' + maskValue(spcU.value));
  const exps = cookies.map((c) => Number(c.expires)).filter((n) => n > 0);
  if (exps.length) {
    out('  berlaku s/d : ' + new Date(Math.max(...exps) * 1000).toISOString().slice(0, 10));
  }

  let ctx;
  try {
    ctx = await openBrowser();
    await ctx.addCookies(cookies);
    const page = ctx.pages()[0] || (await ctx.newPage());
    page.setDefaultTimeout(60000);

    let pdp = null;
    let pageRatingsOk = false;
    let pageRatingsError = null;
    let httpStatus = null;
    let serverDate = null;
    page.on('response', async (r) => {
      const u = r.url();
      if (r.request().resourceType() === 'document' && u.includes('/product/')) {
        httpStatus = r.status();
        serverDate = r.headers()['date'] || null;
      }
      if (u.includes('pdp/get_pc')) {
        try { pdp = await r.json(); } catch { /* abaikan */ }
      } else if (u.includes('/get_ratings')) {
        try {
          const j = await r.json();
          if (j && j.error) pageRatingsError = j.error;
          else pageRatingsOk = true;
        } catch { /* abaikan */ }
      }
    });

    await page.goto(`https://shopee.co.id/product/${shopid}/${itemid}`,
      { waitUntil: 'domcontentloaded', timeout: 60000 });

    const start = Date.now();
    let patched = false;
    while (Date.now() - start < 30000) {
      if (pdp || pageRatingsOk || pageRatingsError) break;
      if (!patched) {
        try {
          patched = await page.evaluate(() => {
            try { return !window.fetch.toString().includes('[native code]'); } catch { return false; }
          });
        } catch { patched = false; }
      }
      if (patched && Date.now() - start > 8000) break;
      await sleep(500);
    }

    const ua = await page.evaluate(() => navigator.userAgent).catch(() => '?');
    const shownUrl = page.url().replace(/[?#].*$/, '');
    out('');
    out('URL akhir     : ' + shownUrl);
    out('Judul         : ' + ((await page.title().catch(() => '')) || '').slice(0, 90));
    out('Status HTTP   : ' + (httpStatus ?? '?'));
    out('SDK anti-bot  : ' + (patched ? 'aktif (fetch ditandatangani)' : 'TIDAK aktif'));
    out('Data produk   : ' + (pdp ? 'termuat' : 'tidak termuat'));
    out('Rating halaman: ' + (pageRatingsOk ? 'ya'
      : pageRatingsError ? 'DITOLAK error ' + pageRatingsError : 'tidak ada request'));
    out('User-Agent    : ' + String(ua).slice(0, 110));

    if (serverDate) {
      const skew = Math.round((Date.now() - Date.parse(serverDate)) / 1000);
      out('Selisih jam   : ' + skew + ' detik'
        + (Math.abs(skew) > 120 ? '  <-- jam sistem tidak akurat' : ''));
    }

    let account = null;
    try {
      account = await page.evaluate(async () => {
        const r = await fetch('/api/v4/account/basic/get_account_info', { credentials: 'include' });
        const j = await r.json().catch(() => null);
        const d = (j && j.data) || {};
        return { status: r.status, error: j && j.error, userid: d.userid ?? null, username: d.username ?? null };
      });
      if (account && account.userid) {
        out('Akun login    : ' + account.userid + (account.username ? ' (' + account.username + ')' : ''));
      } else {
        out('Akun login    : TIDAK terdeteksi (error ' + (account?.error ?? '?') + ')');
      }
    } catch (e) {
      out('Akun login    : gagal dicek (' + (e?.message || e) + ')');
    }

    let ip = null;
    try {
      const p2 = await ctx.newPage();
      await p2.goto('https://api64.ipify.org?format=json', { timeout: 20000 });
      const body = await p2.locator('body').innerText();
      ip = JSON.parse(body).ip;
      await p2.close();
    } catch { /* jaringan membatasi cek IP */ }
    out('IP publik     : ' + maskIp(ip) + (ip && ip.includes(':') ? ' (IPv6)' : ''));

    const test = await page.evaluate(async ({ shopid, itemid }) => {
      const r = await fetch(`/api/v2/item/get_ratings?filter=0&flag=1&itemid=${itemid}&limit=1&offset=0&shopid=${shopid}&type=0`, { credentials: 'include' });
      const j = await r.json().catch(() => null);
      return { status: r.status, error: j && j.error, total: j?.data?.item_rating_count ?? null };
    }, { shopid, itemid }).catch((e) => ({ status: 0, error: 'ERR ' + e.message }));

    out('Uji get_ratings: ' + (test.error
      ? 'GAGAL (HTTP ' + test.status + ', error ' + test.error + ')'
      : 'BERHASIL (total ' + (test.total ?? '?') + ')'));
    const nowUrl = page.url().replace(/[?#].*$/, '');
    if (nowUrl !== shownUrl) {
      out('URL sekarang  : ' + nowUrl + '  <-- halaman dialihkan');
    }
    out('');

    const verdict = [];
    if (page.url().includes('/verify/traffic')) {
      verdict.push('Halaman dialihkan ke /verify/traffic: IP/akun sedang diverifikasi Shopee.');
    }
    if (test.error === 90309999) {
      verdict.push('Request API ditolak 90309999 meski halaman terbuka.');
    }
    if (pdp && pageRatingsOk && !test.error) {
      verdict.push('Sesi ini SEHAT: halaman dan API sama-sama berhasil.');
    }
    if (!patched) {
      verdict.push('SDK anti-bot tidak aktif: halaman tidak selesai dimuat / diblokir.');
    }
    if (serverDate) {
      const skew = Math.round((Date.now() - Date.parse(serverDate)) / 1000);
      if (Math.abs(skew) > 120) {
        verdict.push('Jam sistem meleset ' + skew + ' detik. Aktifkan "Set time automatically" di Windows, restart, lalu coba lagi.');
      }
    }
    if (account && !account.userid) {
      verdict.push('Cookie tidak membawa sesi login yang sah. Ekspor ulang cookies.txt dari Chrome yang benar-benar login.');
    }
    if (!verdict.length) verdict.push('Tidak ada masalah yang terdeteksi dari uji ini.');
    out('KESIMPULAN:');
    verdict.forEach((v) => out('  - ' + v));
    out('');
    out('Kalau Ubuntu berhasil dengan akun yang sama, bandingkan: akun login, IP publik,');
    out('selisih jam, dan apakah Windows memakai VPN/proxy. Coba juga centang');
    out('"Tampilkan browser saat crawling".');
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

async function loadProduct(page, shopid, itemid) {
  const st = { pdp: null, pageRatingsOk: false, pageRatingsError: null,
    patched: false, gotoError: null };
  const onResponse = async (r) => {
    const u = r.url();
    if (u.includes('pdp/get_pc')) {
      try { st.pdp = await r.json(); } catch { /* abaikan */ }
    } else if (u.includes('/get_ratings')) {
      try {
        const j = await r.json();
        if (j && j.error) st.pageRatingsError = j.error;
        else st.pageRatingsOk = true;
      } catch { /* abaikan */ }
    }
  };
  page.on('response', onResponse);
  try {
    await page.goto(`https://shopee.co.id/product/${shopid}/${itemid}`,
      { waitUntil: 'domcontentloaded' });
  } catch (e) {
    st.gotoError = e;
    page.off('response', onResponse);
    return st;
  }
  // Tunggu sampai SDK Shopee menambal window.fetch (penanda: fetch bukan
  // lagi "[native code]") dan/atau halaman selesai memuat data produk.
  const start = Date.now();
  while (Date.now() - start < 30000) {
    if (st.pdp || st.pageRatingsOk || st.pageRatingsError) break;
    if (!st.patched) {
      try {
        st.patched = await page.evaluate(() => {
          try { return !window.fetch.toString().includes('[native code]'); } catch { return false; }
        });
      } catch { st.patched = false; }
    }
    if (st.patched && Date.now() - start > 8000) break;
    await sleep(500);
  }
  page.off('response', onResponse);
  return st;
}

async function waitForVerification(page, timeoutMs, itemid) {
  const start = Date.now();
  let told = false;
  while (Date.now() - start < timeoutMs) {
    await sleep(1500);
    let url = '';
    try { url = page.url(); } catch { return 'closed'; }
    if (!url.includes('/verify/traffic')) return 'ok';
    if (!told) {
      process.stderr.write(`[${itemid}] menunggu verifikasi diselesaikan di jendela browser...\n`);
      told = true;
    }
    let text = '';
    try {
      text = await page.evaluate(() =>
        ((document.body && document.body.innerText) || '').slice(0, 5000));
    } catch { /* halaman sedang berpindah */ }
    if (/verifikasi gagal|verification failed|coba lagi nanti|try again later/i.test(text)) {
      return 'failed';
    }
    if (/verifikasi berhasil|verification successful|verification complete/i.test(text)) {
      return 'ok';
    }
  }
  return 'timeout';
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

  if (DIAGNOSE) {
    if (!COOKIE_FILE || !urls.length) {
      console.error('Pakai: node browser_crawl.mjs --cookies FILE --diagnose URL');
      process.exit(1);
    }
    await diagnose();
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

    let st = await loadProduct(page, shopid, itemid);
    if (st.gotoError) {
      process.stderr.write(`[${itemid}] gagal membuka halaman: ${st.gotoError?.message || st.gotoError}\n`);
      results.push({ shopid, itemid, error: 'goto: ' + (st.gotoError?.message || st.gotoError), reviews: [] });
      continue;
    }

    if (page.url().includes('/verify/traffic')) {
      if (!HEADFUL) {
        process.stderr.write(`[${itemid}] DIBLOKIR verify/traffic (verifikasi Shopee; pakai mode tampil agar bisa diselesaikan manual)\n`);
        results.push({ shopid, itemid, error: 'verify/traffic', reviews: [] });
        continue;
      }
      process.stderr.write(`[${itemid}] VERIFIKASI Shopee muncul — selesaikan di jendela browser (maks 3 menit)...\n`);
      const status = await waitForVerification(page, 180000, itemid);
      if (status !== 'ok') {
        const why = status === 'failed' ? 'verifikasi ditolak Shopee'
          : status === 'closed' ? 'jendela browser ditutup'
          : 'verifikasi tidak selesai';
        process.stderr.write(`[${itemid}] DIBLOKIR verify/traffic (${why})\n`);
        results.push({ shopid, itemid, error: 'verify/traffic: ' + why, reviews: [] });
        continue;
      }
      process.stderr.write(`[${itemid}] verifikasi selesai, memuat ulang produk...\n`);
      st = await loadProduct(page, shopid, itemid);
      if (st.gotoError || page.url().includes('/verify/traffic')) {
        process.stderr.write(`[${itemid}] DIBLOKIR verify/traffic (masih setelah verifikasi)\n`);
        results.push({ shopid, itemid, error: 'verify/traffic', reviews: [] });
        continue;
      }
    }

    const { pdp, pageRatingsOk, pageRatingsError, patched } = st;
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
