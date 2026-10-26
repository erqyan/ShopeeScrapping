"""Web UI lokal untuk Shopee Reviews Crawler.

Jalankan:
    python -m web.app
lalu buka http://127.0.0.1:5000

Semua data disimpan di web/data/:
  state.json  -> daftar produk + pengaturan (bertahan setelah restart)
  cookies.txt -> sesi login Shopee (chmod 600)

Crawl dijalankan dengan `node browser_crawl.mjs` (Playwright Firefox) lalu
dikonversi ke CSV memakai `crawler.importer`.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file

from crawler.collector import parse_product_ref

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / 'web' / 'data'
OUTPUT_DIR = ROOT / 'outputs'
STATE_PATH = DATA_DIR / 'state.json'
COOKIE_PATH = DATA_DIR / 'cookies.txt'
BOOTSTRAP_COOKIES = Path.home() / 'Downloads' / 'cookies.txt'
MAX_JOBS = 20

app = Flask(__name__)
JOBS = {}
LOCK = threading.Lock()

PROGRESS_OPEN = re.compile(r'\[(\d+)\] membuka halaman')
PROGRESS_COUNT = re.compile(r'\[(\d+)\]\s+(\d+)/(\d+) rating')
PROGRESS_WARN = re.compile(r'\[(\d+)\] peringatan:\s*(.+)')
PROGRESS_BLOCK = re.compile(r'\[(\d+)\] DIBLOKIR\s*(.*)')
IMPORT_LINE = re.compile(r'^\s+(\d+)\s+.*:\s+(\d+) baris')


# --------------------------------------------------------------------------- #
# penyimpanan state
# --------------------------------------------------------------------------- #
def default_state():
    return {'products': [], 'settings': {
        'max_reviews': 500, 'min_comment_len': 0, 'headful': False}}


def load_state():
    if not STATE_PATH.exists():
        return default_state()
    try:
        state = json.loads(STATE_PATH.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError):
        return default_state()
    state.setdefault('products', [])
    settings = state.setdefault('settings', {})
    settings.setdefault('max_reviews', 500)
    settings.setdefault('min_comment_len', 0)
    settings.setdefault('headful', False)
    return state


def save_state(state):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix('.tmp')
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding='utf-8')
    os.replace(tmp, STATE_PATH)


# --------------------------------------------------------------------------- #
# cookie / sesi
# --------------------------------------------------------------------------- #
def read_cookie_lines(path=COOKIE_PATH):
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding='utf-8', errors='ignore').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split('\t')
        if len(parts) >= 7:
            out.append(parts)
    return out


def session_info(path=COOKIE_PATH):
    if not path.exists():
        return {'exists': False, 'valid': False, 'message': 'Belum ada sesi login.'}
    rows = read_cookie_lines(path)
    shopee = [r for r in rows if 'shopee' in r[0]]
    names = {r[5] for r in shopee}
    now = time.time()
    expiries = [int(r[4]) for r in shopee if r[4].isdigit() and int(r[4]) > 0]
    expired = bool(expiries) and max(expiries) < now
    logged_in = 'SPC_U' in names or 'SPC_F' in names
    if expired:
        message = 'Sesi kedaluwarsa, upload cookies baru.'
    elif logged_in:
        message = 'Sesi login aktif ({} cookie Shopee).'.format(len(shopee))
    elif shopee:
        message = 'Cookie Shopee ada, tapi tanda login tidak ditemukan.'
    else:
        message = 'File cookie tidak berisi cookie Shopee.'
    return {
        'exists': True,
        'valid': logged_in and not expired,
        'logged_in': logged_in,
        'expired': expired,
        'cookies': len(shopee),
        'updated': time.strftime('%d-%m-%Y %H:%M', time.localtime(path.stat().st_mtime)),
        'message': message,
    }


def bootstrap_session():
    """Kalau belum ada sesi tersimpan, salin dari ~/Downloads/cookies.txt."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if COOKIE_PATH.exists() or not BOOTSTRAP_COOKIES.exists():
        return
    try:
        shutil.copyfile(BOOTSTRAP_COOKIES, COOKIE_PATH)
        os.chmod(COOKIE_PATH, 0o600)
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# util produk
# --------------------------------------------------------------------------- #
def name_from_url(url):
    path = url.split('?')[0].rstrip('/')
    tail = path.rsplit('/', 1)[-1]
    if '-i.' in tail:
        tail = tail.split('-i.')[0]
    else:
        return None
    from urllib.parse import unquote
    return unquote(tail).replace('-', ' ').strip() or None


def add_products(urls):
    state = load_state()
    existing = {(p['shopid'], p['itemid']) for p in state['products']}
    added, skipped, invalid = [], [], []
    for raw in urls:
        raw = raw.strip()
        if not raw:
            continue
        try:
            shopid, itemid = parse_product_ref(raw)
        except ValueError:
            invalid.append(raw)
            continue
        if (shopid, itemid) in existing:
            skipped.append(itemid)
            continue
        product = {
            'id': uuid.uuid4().hex[:10],
            'url': raw,
            'shopid': shopid,
            'itemid': itemid,
            'name': name_from_url(raw),
            'added': time.time(),
            'last_crawled': None,
            'last_rows': None,
        }
        state['products'].append(product)
        existing.add((shopid, itemid))
        added.append(product)
    save_state(state)
    return added, skipped, invalid


# --------------------------------------------------------------------------- #
# job crawl
# --------------------------------------------------------------------------- #
def _update_product(itemid, rows=None):
    if rows is None:
        return
    state = load_state()
    for p in state['products']:
        if p['itemid'] == itemid:
            p['last_crawled'] = time.time()
            p['last_rows'] = rows
    save_state(state)


def _parse_line(job, line):
    # Satu baris bisa memuat keduanya:
    # [22853217492] membuka halaman... 500/54111 rating (17.2s)
    m = PROGRESS_OPEN.search(line)
    if m:
        job['current'] = m.group(1)
        job['products'].setdefault(m.group(1), {
            'itemid': m.group(1), 'done': 0, 'total': None, 'state': 'berjalan'})
    m = PROGRESS_COUNT.search(line)
    if m:
        itemid, done, total = m.group(1), int(m.group(2)), int(m.group(3))
        item = job['products'].setdefault(itemid, {
            'itemid': itemid, 'done': 0, 'total': None, 'state': 'berjalan'})
        item['done'] = done
        item['total'] = total
        return
    m = PROGRESS_BLOCK.search(line)
    if m:
        item = job['products'].setdefault(m.group(1), {
            'itemid': m.group(1), 'done': 0, 'total': None, 'state': 'berjalan'})
        item['state'] = 'diblokir'
        item['message'] = (m.group(2) or 'diblokir').strip()
        return
    m = PROGRESS_WARN.search(line)
    if m:
        item = job['products'].setdefault(m.group(1), {
            'itemid': m.group(1), 'done': 0, 'total': None, 'state': 'berjalan'})
        item['message'] = m.group(2).strip()
        if 'error' in item['message'].lower():
            item['state'] = 'diblokir'


def node_ready():
    """Pesan kesalahan kalau Node/Playwright belum siap, atau None kalau siap."""
    node = shutil.which('node')
    if not node:
        return ('Node.js belum terpasang. Install Node.js LTS dari nodejs.org, '
                'lalu jalankan: npm install dan npx playwright install firefox')
    if not (ROOT / 'node_modules' / 'playwright-core').exists():
        return 'Dependensi Node belum ada. Jalankan: npm install'
    try:
        probe = subprocess.run(
            [node, '-e',
             "const fs=require('fs');"
             "const p=require('playwright-core').firefox.executablePath();"
             "if(!fs.existsSync(p)){console.error(p);process.exit(3)}"],
            cwd=str(ROOT), capture_output=True, text=True,
            encoding='utf-8', errors='replace')
    except OSError as e:
        return 'Node.js tidak bisa dijalankan: {}'.format(e)
    if probe.returncode == 3:
        return ('Firefox untuk Playwright belum terpasang. Jalankan di folder '
                'proyek: node node_modules/playwright-core/cli.js install firefox')
    if probe.returncode != 0:
        return ('Playwright bermasalah: {}'.format(
            (probe.stderr or probe.stdout or '').strip()[:300] or 'tidak diketahui'))
    return None


def _run_job(job_id, products, max_reviews, min_comment_len, headful=False):
    job = JOBS[job_id]
    raw_path = OUTPUT_DIR / '{}_raw.json'.format(job_id)
    csv_path = OUTPUT_DIR / '{}_reviews.csv'.format(job_id)
    urls = ['{}.{}'.format(p['shopid'], p['itemid']) for p in products]
    node = shutil.which('node') or 'node'
    cmd = [node, str(ROOT / 'browser_crawl.mjs'),
           '--cookies', str(COOKIE_PATH), '--out', str(raw_path),
           '--max', str(max_reviews), *urls]
    if headful or os.environ.get('HEADFUL'):
        cmd.append('--headful')
    job['cmd'] = ' '.join(cmd)
    try:
        process = subprocess.Popen(
            cmd, cwd=str(ROOT), stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, bufsize=1,
            encoding='utf-8', errors='replace')
        for line in process.stdout:
            line = line.rstrip('\n')
            job['log'].append(line)
            _parse_line(job, line)
        if process.wait() != 0:
            tail = [ln.strip() for ln in job['log'][-12:] if ln.strip()]
            detail = '\n'.join(tail[-6:])
            raise RuntimeError('crawler berhenti dengan kode {}{}'.format(
                process.returncode, ('\n' + detail) if detail else ''))
        if not raw_path.exists():
            raise RuntimeError('hasil crawl tidak ditemukan')

        env = dict(os.environ, PYTHONIOENCODING='utf-8')
        convert = subprocess.run(
            [sys.executable, '-m', 'crawler.importer', str(raw_path),
             str(csv_path), '--min-comment-len', str(min_comment_len)],
            cwd=str(ROOT), capture_output=True, text=True,
            encoding='utf-8', errors='replace', env=env)
        for line in convert.stdout.splitlines():
            job['log'].append(line)
            m = IMPORT_LINE.match(line)
            if m:
                _update_product(m.group(1), int(m.group(2)))
        if convert.returncode != 0:
            raise RuntimeError(convert.stderr.strip() or 'konversi CSV gagal')

        job['rows'] = _count_rows(csv_path)
        job['csv'] = str(csv_path)
        if job['rows'] == 0:
            raise RuntimeError(_zero_rows_message(job))
        job['status'] = 'selesai'
    except FileNotFoundError:
        job['status'] = 'gagal'
        job['error'] = ('Node.js tidak ditemukan. Install Node.js LTS, '
                        'lalu jalankan: npm install dan npx playwright install firefox')
        job['log'].append('ERROR: ' + job['error'])
    except Exception as e:  # noqa: BLE001 - pesan ditampilkan di UI
        job['status'] = 'gagal'
        job['error'] = str(e)
        job['log'].append('ERROR: {}'.format(e))
    finally:
        job['finished'] = time.time()
        _prune_raw(keep=10)


def _zero_rows_message(job):
    msgs = [p.get('message') for p in job['products'].values() if p.get('message')]
    joined = ' '.join(m for m in msgs if m)
    fetched = sum(int(m.group(1)) for m in
                  (re.search(r'selesai (\d+) rating', ln) for ln in job['log']) if m)
    if '90309999' in joined:
        return ('Tidak ada ulasan yang tersimpan. Shopee menolak sesi ini '
                '(error 90309999).\nBuka shopee.co.id di browser, selesaikan '
                'verifikasi/captcha bila muncul, lalu ekspor cookies.txt baru dan '
                'upload ulang. Kalau baru saja crawling banyak, tunggu beberapa jam.')
    if 'verify/traffic' in joined:
        return ('Tidak ada ulasan yang tersimpan. Halaman produk dialihkan ke '
                'verify/traffic — IP/akun kena verifikasi. Ganti jaringan atau '
                'tunggu beberapa jam, lalu coba lagi.')
    if fetched:
        return ('Rating berhasil diambil ({}), tetapi semuanya tanpa teks sehingga '
                'CSV kosong. Naikkan jumlah review atau coba produk lain.'.format(fetched))
    if joined:
        return 'Tidak ada ulasan yang tersimpan. Penyebab: ' + joined
    return ('Tidak ada ulasan yang tersimpan. Periksa sesi login (Lihat log) dan '
            'pastikan produk memiliki rating.')


def _prune_raw(keep=10):
    """Simpan hanya `keep` file JSON mentah terbaru; CSV tidak dihapus."""
    try:
        files = sorted(OUTPUT_DIR.glob('*_raw.json'),
                       key=lambda f: f.stat().st_mtime, reverse=True)
    except OSError:
        return
    for old in files[keep:]:
        try:
            old.unlink()
        except OSError:
            pass


def _count_rows(path):
    try:
        with open(path, encoding='utf-8') as f:
            return max(sum(1 for _ in f) - 1, 0)
    except FileNotFoundError:
        return 0


# --------------------------------------------------------------------------- #
# routes
# --------------------------------------------------------------------------- #
@app.get('/')
def index():
    state = load_state()
    return render_template('index.html', state=state,
                           session=session_info(),
                           max_reviews=state['settings']['max_reviews'],
                           min_comment_len=state['settings']['min_comment_len'],
                           headful=state['settings'].get('headful', False))


@app.get('/api/products')
def api_products():
    return jsonify(load_state()['products'])


@app.post('/api/products')
def api_add_products():
    payload = request.get_json(silent=True) or {}
    text = payload.get('urls') or request.form.get('urls') or ''
    added, skipped, invalid = add_products(text.splitlines())
    return jsonify({'added': added, 'skipped': skipped, 'invalid': invalid,
                    'products': load_state()['products']})


@app.delete('/api/products/<product_id>')
def api_delete_product(product_id):
    state = load_state()
    state['products'] = [p for p in state['products'] if p['id'] != product_id]
    save_state(state)
    return jsonify({'ok': True})


@app.post('/api/products/clear')
def api_clear_products():
    state = load_state()
    state['products'] = []
    save_state(state)
    return jsonify({'ok': True})


@app.post('/api/settings')
def api_settings():
    payload = request.get_json(silent=True) or {}
    state = load_state()
    try:
        state['settings']['max_reviews'] = max(1, int(payload.get('max_reviews', 500)))
    except (TypeError, ValueError):
        return jsonify({'error': 'Jumlah ulasan harus angka.'}), 400
    try:
        state['settings']['min_comment_len'] = max(0, int(payload.get('min_comment_len', 0)))
    except (TypeError, ValueError):
        state['settings']['min_comment_len'] = 0
    state['settings']['headful'] = bool(payload.get('headful', state['settings']['headful']))
    save_state(state)
    return jsonify({'settings': state['settings']})


@app.post('/api/session')
def api_session_upload():
    upload = request.files.get('cookies_file')
    if not upload or not upload.filename:
        return jsonify({'error': 'Pilih file cookies.txt'}), 400
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = DATA_DIR / 'cookies.upload'
    upload.save(tmp)
    os.chmod(tmp, 0o600)
    info = session_info(tmp)
    if not info['valid']:
        tmp.unlink(missing_ok=True)
        return jsonify({'error': info['message'], 'session': session_info()}), 400
    os.replace(tmp, COOKIE_PATH)
    return jsonify({'ok': True, 'session': session_info()})


@app.get('/api/session')
def api_session():
    return jsonify(session_info())


@app.post('/api/session/diagnose')
def api_session_diagnose():
    """Buka satu produk dengan browser lalu laporkan kondisi sesi apa adanya."""
    payload = request.get_json(silent=True) or {}
    state = load_state()
    products = state['products']
    if not products:
        return jsonify({'error': 'Tambahkan minimal satu produk untuk diuji.'}), 400
    if not COOKIE_PATH.exists():
        return jsonify({'error': 'Belum ada cookies.txt. Upload sesi login dulu.'}), 400
    pid = payload.get('product_id')
    product = next((p for p in products if p['id'] == pid), products[0])
    problem = node_ready()
    if problem:
        return jsonify({'error': problem}), 400
    cmd = [shutil.which('node'), str(ROOT / 'browser_crawl.mjs'),
           '--cookies', str(COOKIE_PATH), '--diagnose',
           '{}.{}'.format(product['shopid'], product['itemid'])]
    if payload.get('headful'):
        cmd.append('--headful')
    env = os.environ.copy()
    env['PYTHONIOENCODING'] = 'utf-8'
    try:
        proc = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True,
                              encoding='utf-8', errors='replace',
                              timeout=180, env=env)
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Diagnosa melebihi 180 detik.'}), 504
    except OSError as exc:
        return jsonify({'error': 'Node.js tidak bisa dijalankan: {}'.format(exc)}), 500
    output = ((proc.stdout or '') + (proc.stderr or '')).strip()
    if not output:
        return jsonify({'error': 'Diagnosa tidak menghasilkan output (kode {}).'.format(
            proc.returncode)}), 500
    return jsonify({'ok': proc.returncode == 0, 'output': output})


@app.post('/api/crawl')
def api_crawl():
    payload = request.get_json(silent=True) or {}
    state = load_state()
    ids = payload.get('product_ids') or []
    products = [p for p in state['products'] if not ids or p['id'] in ids]
    if not products:
        return jsonify({'error': 'Pilih minimal satu produk.'}), 400
    info = session_info()
    if not info['valid']:
        return jsonify({'error': info['message']}), 400
    problem = node_ready()
    if problem:
        return jsonify({'error': problem}), 400

    try:
        max_reviews = max(1, min(int(payload.get('max_reviews', 500)), 100000))
    except (TypeError, ValueError):
        return jsonify({'error': 'Jumlah ulasan harus angka.'}), 400
    try:
        min_len = max(0, int(payload.get('min_comment_len', 0)))
    except (TypeError, ValueError):
        min_len = 0
    headful = bool(payload.get('headful', state['settings'].get('headful', False)))

    job_id = uuid.uuid4().hex[:12]
    with LOCK:
        JOBS[job_id] = {
            'id': job_id, 'status': 'berjalan', 'log': [], 'products': {},
            'current': None, 'rows': 0, 'error': None, 'created': time.time(),
            'total_products': len(products), 'max_reviews': max_reviews,
        }
        if len(JOBS) > MAX_JOBS:
            for old in sorted(JOBS, key=lambda k: JOBS[k]['created'])[:-MAX_JOBS]:
                JOBS.pop(old, None)
    threading.Thread(target=_run_job, daemon=True,
                     args=(job_id, products, max_reviews, min_len, headful)).start()
    return jsonify({'job_id': job_id})


@app.get('/api/jobs/<job_id>')
def api_job(job_id):
    job = JOBS.get(job_id)
    if not job:
        return jsonify({'error': 'job tidak ditemukan'}), 404
    max_reviews = job.get('max_reviews', 0)
    products = []
    for p in job['products'].values():
        # target = yang diminta (dibatasi jumlah rating yang tersedia)
        available = p['total']
        target = max_reviews if available is None else min(max_reviews, available)
        products.append({**p, 'target': target})

    if job['status'] == 'selesai':
        progress = 100
    else:
        want = sum(p['target'] or 0 for p in products)
        got = sum(min(p['done'], p['target'] or p['done']) for p in products)
        # produk yang belum mulai tetap dihitung sebagai sisa target
        remaining_products = max(job['total_products'] - len(products), 0)
        want += remaining_products * max_reviews
        progress = min(99, int(got * 100 / want)) if want else 0

    return jsonify({
        'id': job['id'], 'status': job['status'], 'progress': progress,
        'products': products, 'rows': job['rows'], 'error': job['error'],
        'log': job['log'][-100:], 'total_products': job['total_products'],
    })


@app.get('/api/jobs/<job_id>/download')
def api_download(job_id):
    job = JOBS.get(job_id)
    if not job or not job.get('csv') or not os.path.exists(job['csv']):
        return jsonify({'error': 'CSV belum tersedia'}), 404
    return send_file(job['csv'], as_attachment=True,
                     download_name='shopee_reviews_{}.csv'.format(job_id))


bootstrap_session()
DATA_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print('Buka http://127.0.0.1:{}'.format(port))
    app.run(host='127.0.0.1', port=port, debug=False, threaded=True)
