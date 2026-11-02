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

import { firefox, chromium } from 'playwright-core';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const DOMAIN = 'shopee.co.id';
const INSTALL_HINT = 'node node_modules/playwright-core/cli.js install firefox';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

const COOKIE_FILE = arg('cookies');
const OUT = arg('out', 'raw_reviews.json');
const MAX_REVIEWS = Number(arg('max', 500));
let HEADFUL = process.argv.includes('--headful');
const CHECK_ONLY = process.argv.includes('--check');
const DIAGNOSE = process.argv.includes('--diagnose');
const NO_CDP = process.argv.includes('--no-cdp');
const CDP_URL = arg('cdp', 'http://127.0.0.1:9222');
// true kalau crawl memakai Chrome asli milik user lewat CDP (bukan Firefox).
const USING_CDP = { value: false, browser: null };
const VERIFY_TIMEOUT = Math.max(60, Number(arg('verify-timeout', 600))) * 1000;
const FLAGS = ['--cookies', '--out', '--max', '--cdp', '--verify-timeout'];
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

function isVerifyUrl(url) {
  return /\/verify\//.test(String(url || ''));
}

// Bedakan jenis halaman verifikasi Shopee. Yang penting: /verify/captcha yang
// langsung menampilkan "Verifikasi gagal" berarti anti-fraud menolak sesi ini —
// captcha-nya bahkan tidak bisa dibuat, jadi menunggu manual tidak ada gunanya.
async function classifyVerify(page) {
  let url = '';
  try { url = page.url(); } catch { /* abaikan */ }
  let text = '';
  try {
    text = await page.evaluate(() =>
      ((document.body && document.body.innerText) || '').replace(/\s+/g, ' '));
  } catch { /* halaman sedang berpindah */ }
  if (/verifikasi gagal|verification failed|coba lagi nanti|try again later/i.test(text)) {
    return url.includes('/verify/captcha') ? 'captcha-ditolak' : 'verifikasi-ditolak';
  }
  if (url.includes('/verify/captcha')) return 'captcha';
  if (url.includes('/verify/traffic/error')) return 'traffic-error';
  return 'traffic';
}

async function cdpAvailable() {
  if (NO_CDP) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 800);
    const res = await fetch(CDP_URL.replace(/\/$/, '') + '/json/version',
      { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function openBrowser() {
  // Chrome asli (profil + histori + login user) jauh lebih dipercaya Shopee
  // daripada Firefox baru yang hanya disuntik cookies. Kalau port debug
  // Chrome terbuka, pakai itu dulu.
  if (await cdpAvailable()) {
    try {
      const browser = await chromium.connectOverCDP(CDP_URL);
      const ctx = browser.contexts()[0] || (await browser.newContext());
      USING_CDP.value = true;
      USING_CDP.browser = browser;
      HEADFUL = true;
      return ctx;
    } catch (e) {
      process.stderr.write('Chrome CDP tidak bisa dipakai ('
        + (e?.message || e) + '), memakai Firefox...\n');
      USING_CDP.value = false;
    }
  }

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

// Di mode CDP jangan tutup Chrome milik user; cukup lepaskan koneksinya.
async function closeBrowser(ctx, page) {
  if (USING_CDP.value) {
    if (page) await page.close().catch(() => {});
    if (USING_CDP.browser) await USING_CDP.browser.close().catch(() => {});
    return;
  }
  if (ctx) await ctx.close().catch(() => {});
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
  out('Produk uji    : ' + shopid + '.' + itemid);

  const cookies = COOKIE_FILE ? loadCookies(COOKIE_FILE) : [];
  const names = cookies.map((c) => c.name);
  const keys = ['SPC_U', 'SPC_F', 'SPC_SI', 'SPC_T', 'csrftoken', 'SPC_CDS'];
  out('Cookie        : ' + (COOKIE_FILE
    ? cookies.length + ' butir | ' + keys.filter((k) => names.includes(k)).join(', ')
    : '(tidak dipakai)'));
  const spcU = cookies.find((c) => c.name === 'SPC_U');
  if (spcU) out('  SPC_U       : ' + maskValue(spcU.value));
  const exps = cookies.map((c) => Number(c.expires)).filter((n) => n > 0);
  if (exps.length) {
    out('  berlaku s/d : ' + new Date(Math.max(...exps) * 1000).toISOString().slice(0, 10));
  }

  let ctx;
  let page = null;
  try {
    ctx = await openBrowser();
    out('Mode browser  : ' + (USING_CDP.value
      ? 'Chrome asli via CDP (' + CDP_URL + ')'
      : HEADFUL ? 'tampil (headful)' : 'tersembunyi (headless)'));
    if (USING_CDP.value) {
      page = await ctx.newPage();
    } else {
      if (!cookies.length) {
        throw new Error('File cookie wajib diisi kalau tidak memakai Chrome CDP.\n'
          + 'Pakai: node browser_crawl.mjs --cookies FILE --diagnose URL');
      }
      await ctx.addCookies(cookies);
      page = ctx.pages()[0] || (await ctx.newPage());
    }
    page.setDefaultTimeout(60000);

    let pdp = null;
    let pageRatingsOk = false;
    let pageRatingsError = null;
    let captchaGenError = null;
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
      } else if (u.includes('/api/v4/account/basic/get_account_info')) {
        // respons akun bisa diperiksa ulang kalau perlu
      } else if (u.includes('/anti_fraud/captcha/generate')) {
        try {
          const j = await r.json();
          if (j && j.error) captchaGenError = j.error;
        } catch { /* abaikan */ }
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

    const readAccount = () => page.evaluate(async () => {
      const r = await fetch('/api/v4/account/basic/get_account_info', { credentials: 'include' });
      const j = await r.json().catch(() => null);
      const d = (j && j.data) || {};
      return { status: r.status, error: j && j.error, userid: d.userid ?? null, username: d.username ?? null };
    }).catch(() => null);

    // Cek login sedini mungkin: setelah dialihkan ke /verify/traffic/error,
    // endpoint akun ikut menolak (error 19) walau sesi sebenarnya masih valid.
    await page.waitForTimeout(1200);
    let account = await readAccount();

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

    // Kalau cek awal belum berhasil (mis. halaman sempat berpindah), coba lagi.
    if (!account || !account.userid) {
      const late = await readAccount();
      if (late && late.userid) account = late;
      else if (!account) account = late;
    }
    if (account && account.userid) {
      out('Akun login    : ' + account.userid + (account.username ? ' (' + account.username + ')' : ''));
    } else {
      out('Akun login    : TIDAK terdeteksi (error ' + (account?.error ?? '?') + ')');
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
    if (captchaGenError) {
      out('Captcha Shopee: DITOLAK (generate error ' + captchaGenError + ')');
    }
    const nowUrl = page.url().replace(/[?#].*$/, '');
    if (nowUrl !== shownUrl) {
      out('URL sekarang  : ' + nowUrl + '  <-- halaman dialihkan');
    }
    out('');

    const onVerify = isVerifyUrl(page.url());
    const verdict = [];
    if (onVerify) {
      const shown = page.url().replace(/[?#].*$/, '');
      verdict.push('Halaman dialihkan ke ' + shown + ' (verifikasi Shopee).');
      if (page.url().includes('/verify/captcha') || captchaGenError === 90309999) {
        verdict.push('Shopee MENOLAK membuat captcha (generate error ' +
          (captchaGenError ?? 90309999) + '). Ini pembatasan anti-fraud pada sesi/akun atau IP,');
        verdict.push('bukan masalah cookie — login di atas tetap valid. Ganti jaringan (hotspot HP /');
        verdict.push('restart router), atau tunggu beberapa jam, lalu jalankan diagnosa lagi.');
      } else if (page.url().includes('/verify/traffic/error')) {
        verdict.push('Verifikasi langsung ditolak. Biasanya karena IP/akun sedang dibatasi;');
        verdict.push('coba ganti jaringan (hotspot HP) atau tunggu beberapa jam.');
      }
    }
    if (test.error === 90309999 && onVerify) {
      verdict.push('Request API juga ditolak 90309999: pembatasan anti-fraud, bukan tanda tangan SDK.');
    } else if (test.error === 90309999) {
      verdict.push('Request API ditolak 90309999 meski halaman terbuka (anti-fraud).');
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
      if (onVerify) {
        verdict.push('Akun tidak bisa dicek karena halaman verifikasi — cookie belum tentu salah.');
      } else {
        verdict.push('Cookie tidak membawa sesi login yang sah. Ekspor ulang cookies.txt dari Chrome yang benar-benar login.');
      }
    }
    if (!verdict.length) verdict.push('Tidak ada masalah yang terdeteksi dari uji ini.');
    out('KESIMPULAN:');
    verdict.forEach((v) => out('  - ' + v));
    out('');
    out('Kalau jaringan lain tetap gagal, tunggu 6-24 jam atau pakai akun Shopee lain.');
    out('Kalau muncul halaman verifikasi yang bisa diselesaikan, centang');
    out('"Tampilkan browser saat crawling" lalu selesaikan di jendela Firefox.');
  } finally {
    if (ctx) await closeBrowser(ctx, page);
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
  let lastHint = 0;
  while (Date.now() - start < timeoutMs) {
    await sleep(1500);
    let url = '';
    try { url = page.url(); } catch { return 'closed'; }
    if (!isVerifyUrl(url)) return 'ok';
    if (!told) {
      process.stderr.write(`[${itemid}] menunggu verifikasi diselesaikan di jendela browser`
        + ` (maks ${Math.round(timeoutMs / 60000)} menit)...\n`);
      told = true;
      lastHint = Date.now();
    }
    // Jangan menganggap "Verifikasi gagal" sebagai akhir: user bisa klik
    // "Coba Lagi" dan menyelesaikan verifikasi secara manual.
    if (Date.now() - lastHint > 30000) {
      process.stderr.write(`[${itemid}] masih menunggu verifikasi — jika muncul`
        + ' "Verifikasi gagal", klik "Coba Lagi" di jendela browser.\n');
      lastHint = Date.now();
    }
    let text = '';
    try {
      text = await page.evaluate(() =>
        ((document.body && document.body.innerText) || '').slice(0, 5000));
    } catch { /* halaman sedang berpindah */ }
    if (/verifikasi berhasil|verification successful|verification complete/i.test(text)) {
      return 'ok';
    }
  }
  return 'timeout';
}

// API ditolak 90309999 tapi halaman tidak mengarah ke /verify/. Dalam mode
// tampil, muat ulang produk supaya tantangan muncul, lalu biarkan user
// menyelesaikannya dan coba API lagi sampai berhasil / timeout.
async function waitForRatingsRecovery(page, shopid, itemid, timeoutMs) {
  let start = Date.now();
  await page.goto(`https://shopee.co.id/product/${shopid}/${itemid}`,
    { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(3000);
  if (isVerifyUrl(page.url())) {
    const status = await waitForVerification(page, timeoutMs, itemid);
    if (status !== 'ok') return null;
    start = Date.now(); // beri waktu baru untuk API setelah verifikasi selesai
  }
  while (Date.now() - start < timeoutMs) {
    const r = await page.evaluate(async ({ shopid, itemid }) => {
      try {
        const res = await fetch(`/api/v2/item/get_ratings?filter=0&flag=1`
          + `&itemid=${itemid}&limit=50&offset=0&shopid=${shopid}&type=0`,
        { credentials: 'include' });
        const j = await res.json().catch(() => ({}));
        if (j.error) return { error: j.error };
        const d = j.data || {};
        return {
          ratings: d.ratings || [],
          has_more: d.has_more ?? false,
          total: d.item_rating_count ?? null,
        };
      } catch { return { error: 'EXC' }; }
    }, { shopid, itemid }).catch(() => null);
    if (r && !r.error) return r;
    let url = '';
    try { url = page.url(); } catch { return null; }
    if (isVerifyUrl(url)) {
      const status = await waitForVerification(page,
        Math.max(30000, timeoutMs - (Date.now() - start)), itemid);
      if (status !== 'ok') return null;
      start = Date.now();
    }
    await sleep(3000);
  }
  return null;
}

async function main() {
  if (CHECK_ONLY) {
    console.log('Node.js         : ' + process.version);
    console.log('Platform        : ' + process.platform + ' ' + process.arch);
    const exe = firefox.executablePath();
    console.log('Firefox         : ' + exe);
    console.log('  terpasang     : ' + (existsSync(exe) ? 'ya' : 'TIDAK -> ' + INSTALL_HINT));
    try {
      console.log('Chrome CDP      : ' + (await cdpAvailable() ? 'terdeteksi di ' + CDP_URL : 'tidak ada'));
    } catch { console.log('Chrome CDP      : tidak bisa dicek'); }
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
    if (!urls.length) {
      console.error('Pakai: node browser_crawl.mjs [--cookies FILE] --diagnose URL\n'
        + '(bisa juga pakai Chrome yang sudah login: jalankan Chrome dengan --remote-debugging-port=9222)');
      process.exit(1);
    }
    await diagnose();
    return;
  }

  if (!urls.length) {
    console.error('Pakai: node browser_crawl.mjs --cookies FILE --out FILE [--max N] [--headful] URL...');
    process.exit(1);
  }

  const ctx = await openBrowser();
  let page;
  if (USING_CDP.value) {
    page = await ctx.newPage();
  } else {
    if (!COOKIE_FILE) {
      await closeBrowser(ctx, null);
      throw new Error('Butuh --cookies FILE kalau tidak memakai Chrome CDP.');
    }
    await ctx.addCookies(loadCookies(COOKIE_FILE));
    page = ctx.pages()[0] || (await ctx.newPage());
  }
  process.stderr.write(USING_CDP.value
    ? `Mode browser: Chrome asli via CDP (${CDP_URL})\n`
    : 'Mode browser: Firefox Playwright + cookies.txt\n');
  page.setDefaultTimeout(60000);
  const results = [];
  let blockedAll = false;

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

    if (isVerifyUrl(page.url())) {
      const reason = await classifyVerify(page);
      const label = reason === 'captcha-ditolak' ? 'captcha — klik "Coba Lagi" lalu selesaikan'
        : reason === 'verifikasi-ditolak' ? 'verifikasi — klik "Coba Lagi" lalu selesaikan'
        : reason === 'traffic-error' ? 'verify/traffic/error (login/verifikasi)'
        : reason === 'captcha' ? 'captcha'
        : 'verify/traffic';
      if (!HEADFUL) {
        process.stderr.write(`[${itemid}] DIBLOKIR ${label} — centang`
          + ' "Tampilkan browser saat crawling" agar bisa diverifikasi manual.\n');
        results.push({ shopid, itemid, error: reason, reviews: [] });
        blockedAll = true;
        process.stderr.write('[SEMUA] DIBLOKIR verifikasi Shopee — sisa produk dilewati.\n');
        break;
      }

      // Mode tampil: beri kesempatan user menyelesaikan verifikasi manual,
      // termasuk menekan "Coba Lagi" kalau Shopee sempat menolak.
      let verified = false;
      let why = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        process.stderr.write(`[${itemid}] VERIFIKASI Shopee (${label}) — selesaikan`
          + ` di jendela browser (maks ${Math.round(VERIFY_TIMEOUT / 60000)} menit)...\n`);
        const status = await waitForVerification(page, VERIFY_TIMEOUT, itemid);
        if (status === 'closed') { why = 'jendela browser ditutup'; break; }
        if (status === 'timeout') { why = 'verifikasi tidak selesai'; break; }
        process.stderr.write(`[${itemid}] verifikasi selesai, memuat ulang produk...\n`);
        st = await loadProduct(page, shopid, itemid);
        if (st.gotoError) {
          why = 'gagal memuat ulang: ' + (st.gotoError?.message || st.gotoError);
          break;
        }
        if (!isVerifyUrl(page.url())) { verified = true; break; }
        process.stderr.write(`[${itemid}] halaman masih dialihkan ke verifikasi;`
          + ' menunggu lagi...\n');
      }
      if (!verified) {
        process.stderr.write(`[${itemid}] DIBLOKIR verifikasi Shopee (${why || 'belum selesai'})\n`);
        results.push({ shopid, itemid,
          error: 'verifikasi: ' + (why || 'belum selesai'), reviews: [] });
        blockedAll = true;
        process.stderr.write('[SEMUA] DIBLOKIR verifikasi Shopee — sisa produk dilewati.\n');
        break;
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
      let batch = await page.evaluate(async ({ itemid, shopid, offset, limit }) => {
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
        if (batch.error === 90309999 && reviews.length === 0 && retry < 2) {
          retry += 1;
          process.stderr.write(`[${itemid}] menunggu SDK halaman siap... (${retry}/2)\n`);
          await sleep(1500);
          continue;
        }
        if (batch.error === 90309999 && reviews.length === 0 && HEADFUL) {
          process.stderr.write(`[${itemid}] VERIFIKASI Shopee (API ditolak 90309999) —`
            + ' selesaikan di jendela browser; crawler menunggu lalu lanjut otomatis...\n');
          const recovered = await waitForRatingsRecovery(
            page, shopid, itemid, VERIFY_TIMEOUT);
          if (recovered) {
            process.stderr.write(`[${itemid}] verifikasi berhasil,`
              + ' melanjutkan pengambilan ulasan...\n');
            batch = recovered;
          }
        }
        if (batch.http || batch.error) {
          if (batch.error === 90309999 && reviews.length === 0) {
            blockedAll = true;
          }
          error = batch.http ? 'HTTP ' + batch.http : 'error ' + batch.error;
          break;
        }
      }
      if (offset === 0) total = batch.total;
      reviews.push(...batch.ratings);
      offset += limit;
      hasMore = !!batch.has_more && batch.ratings.length === limit;
      process.stderr.write(`[${itemid}] ${Math.min(reviews.length, MAX_REVIEWS)}/${total ?? '?'} rating\n`);
      if (total !== null && offset >= total) break;
      // Jeda kecil + acak supaya pola request tidak terlalu "robot".
      if (hasMore) await sleep(600 + Math.floor(Math.random() * 600));
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
    if (blockedAll) {
      if (error && String(error).includes('90309999')) {
        process.stderr.write('[SEMUA] API ulasan ditolak anti-fraud (90309999) — '
          + 'sisa produk dilewati. Ganti jaringan atau tunggu beberapa jam.\n');
      }
      break;
    }
    await sleep(1000 + Math.floor(Math.random() * 800));
  }

  writeFileSync(OUT, JSON.stringify(results, null, 1));
  process.stderr.write(`Tersimpan: ${OUT}\n`);
  await closeBrowser(ctx, page);
}

main().catch((e) => {
  console.error('ERROR: ' + (e?.message || e));
  process.exit(1);
});
