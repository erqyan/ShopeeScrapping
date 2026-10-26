import json
import os
import time

import requests

from .utils import cfg

BASE_HEADERS = {
    'accept': 'application/json',
    'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'referer': 'https://{}/'.format(cfg.domain),
    'user-agent': ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
                   '(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'),
    'x-api-source': 'pc',
    'x-requested-with': 'XMLHttpRequest',
    'x-shopee-language': 'id',
}

_session = None


class ShopeeBlocked(Exception):
    '''Shopee menolak request (anti-bot / butuh login).'''


def load_cookies(path):
    '''Baca cookie dari file .json ({nama: nilai}) atau format Netscape
    (cookies.txt hasil ekstensi browser).

    File ekspor browser biasanya berisi semua situs (ribuan baris). Hanya cookie
    untuk domain Shopee yang dipakai, kalau tidak header request membengkak
    (nginx: "400 Request Header Or Cookie Too Large").
    '''
    if not path:
        return {}
    if not os.path.exists(path):
        raise FileNotFoundError('File cookie tidak ditemukan: {}'.format(path))
    with open(path, 'r', encoding='utf-8') as f:
        raw = f.read().strip()
    if raw.startswith('{'):
        return json.loads(raw)

    cookies = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split('\t')
        if len(parts) < 7:
            continue
        domain, _flag, path_, _secure, _expires, name, value = parts[:7]
        host = domain.lstrip('.')
        if host != cfg.domain and not host.endswith('.' + cfg.domain):
            continue
        # Cookie dengan path lebih spesifik menang; kalau sama, yang terakhir.
        if name in cookies and cookies[name][1] != '/' and path_ == '/':
            cookies[name] = (value, path_)
        elif name not in cookies:
            cookies[name] = (value, path_)
    return {name: value for name, (value, _path) in cookies.items()}


def get_session(cookies=None):
    global _session
    if _session is None or cookies:
        _session = requests.Session()
        _session.headers.update(BASE_HEADERS)
        for name, value in (cookies or {}).items():
            _session.cookies.set(name, value, domain='.' + cfg.domain)
    return _session


def _get(url, params=None, retries=3, timeout=25):
    session = get_session()
    last = None
    for attempt in range(retries):
        try:
            r = session.get(url, params=params, timeout=timeout)
        except requests.RequestException as e:
            last = e
            time.sleep(1.5 * (attempt + 1))
            continue
        if r.status_code == 403:
            raise ShopeeBlocked(
                'HTTP 403 dari Shopee. Butuh cookie sesi login yang valid '
                '(lihat --cookies).')
        if r.status_code != 200:
            last = 'HTTP {}'.format(r.status_code)
            time.sleep(1.5 * (attempt + 1))
            continue
        data = r.json()
        # Respons anti-bot berbentuk {"0":2,"3":90309999,"error":90309999,...}
        if isinstance(data, dict) and 'data' not in data and data.get('error'):
            raise ShopeeBlocked(
                'Shopee menolak request (error {}). Sesi tidak login / IP '
                'terdeteksi bot.'.format(data.get('error')))
        return data
    raise RuntimeError('Gagal mengambil {}: {}'.format(url, last))


def _api(path):
    return 'https://{}{}'.format(cfg.domain, path)


def get_json_product(itemid, limit, offset, shopid, type=0):
    '''Get JSON of a product
    * type = 0: get all ratings
    * type = 1..5: get ratings based on rating stars
    '''
    return _get(_api('/api/v2/item/get_ratings'), params={
        'filter': 0,
        'flag': 1,
        'itemid': itemid,
        'limit': limit,
        'offset': offset,
        'shopid': shopid,
        'type': type,
    })


def get_json_recommend(limit, offset):
    return _get(_api('/api/v4/recommend/recommend'), params={
        'bundle': 'daily_discover_main',
        'limit': limit,
        'offset': offset,
    })


def get_json_campaign(label, limit, offset):
    return _get(_api('/api/v4/recommend/recommend'), params={
        'bundle': 'daily_discover_campaign',
        'label': label,
        'limit': limit,
        'offset': offset,
    })


def get_json_pdp(itemid, shopid):
    '''Detail produk (nama toko, rating, jumlah terjual).'''
    return _get(_api('/api/v4/pdp/get_pc'), params={
        'item_id': itemid,
        'shop_id': shopid,
        'tz_offset_in_minutes': 420,
        'detail_level': 0,
    })
