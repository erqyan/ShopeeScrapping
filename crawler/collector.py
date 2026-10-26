import re
import time

from tqdm import tqdm

from .api import (ShopeeBlocked, get_json_campaign, get_json_pdp,
                  get_json_product, get_json_recommend)
from .parser import (count_ratings_from_json, get_product_info_from_pdp,
                     get_products_from_json, get_ratings_from_json)
from .utils import export_to_csv, export_to_text_file

PRODUCT_PATTERNS = [
    r'-i\.(\d+)\.(\d+)',
    r'/product/(\d+)/(\d+)',
]


def parse_product_ref(text):
    '''Ambil (shopid, itemid) dari URL produk Shopee atau "shopid.itemid".'''
    text = str(text).strip()
    for pattern in PRODUCT_PATTERNS:
        m = re.search(pattern, text)
        if m:
            return m.group(1), m.group(2)
    m = re.match(r'^(\d+)[.\-](\d+)$', text)
    if m:
        return m.group(1), m.group(2)
    raise ValueError('Tidak bisa membaca shopid/itemid dari: {}'.format(text))


class Collector:

    def __init__(self):
        pass

    def get_all_reviews(self,
                        itemid,
                        shopid,
                        limit=6,
                        offset=0,
                        max_cmt=100,
                        min_len_cmt=4,
                        type=0):
        result = []
        with tqdm(total=(max_cmt // limit + 1) * limit,
                  desc='  review {}'.format(itemid),
                  leave=False) as pbar:
            while True:
                json_data = get_json_product(itemid, limit, offset, shopid,
                                             type)
                # Berhenti hanya kalau halaman benar-benar kosong, bukan saat
                # semua komentar tersaring oleh min_len_cmt.
                if count_ratings_from_json(json_data) == 0:
                    break
                result += get_ratings_from_json(json_data, min_len_cmt)
                offset += limit
                pbar.update(limit)
                if len(result) >= max_cmt:
                    break
        return result[:max_cmt]

    def get_product_info(self, itemid, shopid):
        try:
            return get_product_info_from_pdp(get_json_pdp(itemid, shopid),
                                             itemid, shopid)
        except Exception:
            return {
                'shopid': shopid,
                'itemid': itemid,
                'product_name': None,
                'shop_name': None,
                'shop_rating': None,
                'sold': None,
                'rating_star': None,
                'rating_count': None,
            }

    def collect_product(self,
                        product,
                        filename,
                        max_cmt=100,
                        min_len_cmt=4,
                        ratetypes=None,
                        as_csv=True):
        '''Crawl ulasan satu produk (URL Shopee atau "shopid.itemid").'''
        shopid, itemid = parse_product_ref(product)
        info = self.get_product_info(itemid, shopid)
        reviews = []
        if ratetypes:
            for t in ratetypes:
                reviews += self.get_all_reviews(itemid, shopid,
                                                max_cmt=max_cmt,
                                                min_len_cmt=min_len_cmt,
                                                type=t)
        else:
            reviews += self.get_all_reviews(itemid, shopid,
                                            max_cmt=max_cmt,
                                            min_len_cmt=min_len_cmt)
        writer = export_to_csv if as_csv else export_to_text_file
        writer(reviews, info, filename)
        return reviews

    def collect_products(self,
                         products,
                         filename,
                         max_cmt=100,
                         min_len_cmt=4,
                         ratetypes=None,
                         as_csv=True):
        '''Crawl ulasan beberapa produk lalu tulis CSV (header sekali).'''
        total = 0
        stats = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0}
        for product in tqdm(products, desc='produk'):
            try:
                reviews = self.collect_product(product,
                                               filename,
                                               max_cmt=max_cmt,
                                               min_len_cmt=min_len_cmt,
                                               ratetypes=ratetypes,
                                               as_csv=as_csv)
            except ShopeeBlocked:
                raise
            except Exception as e:
                print('  gagal {}: {}'.format(product, e))
                continue
            total += len(reviews)
            for r in reviews:
                stats[r['rating_star']] += 1
            print('  {} ulasan ditulis (total {})'.format(len(reviews), total))
        print('Thống kê số lượng đánh giá ghi nhận:')
        for k, v in stats.items():
            print('{}*: {} reviews'.format(k, v))
        return total

    def get_all_recommended_products(self,
                                     max_products=100,
                                     limit=10,
                                     offset=0,
                                     get_top_product=False):
        result = []
        if max_products < limit:
            limit = max_products
        with tqdm(total=(max_products // limit + 1) * limit) as pbar:
            while True:
                start_time = time.time()
                # Notes: The number of products may be smaller than limit number although max_products < limit
                # So the number of result can be larger than the max_products
                json_data = get_json_recommend(limit, offset)
                products = get_products_from_json(json_data, get_top_product)
                if products == [] or len(result) >= max_products:
                    break
                else:
                    result += products
                    pbar.set_description(
                        'Đã lấy về {} sản phẩm trên tổng số tối đa {} sản phẩm. Mất {:0.2f} mili giây'
                        .format(len(result), max_products,
                                (time.time() - start_time) * 1000))
                offset += limit
                pbar.update(limit)

        return result[:max_products]

    def collect_reviews_product(self,
                                filename,
                                max_products,
                                min_len_cmt=4,
                                ratetypes=[],
                                as_csv=True):
        '''Collect all reviews of products with specific rating_star
        * type = array [0]: get all rating_stars
        * type = array [1..5]: get only these rating_stars
        '''
        products = self.get_all_recommended_products(max_products=max_products,
                                                     get_top_product=True)
        refs = ['{}.{}'.format(p['shopid'], p['itemid']) for p in products]
        if as_csv:
            open(filename, 'w', encoding='utf-8').close()
        return self.collect_products(refs,
                                     filename,
                                     min_len_cmt=min_len_cmt,
                                     ratetypes=ratetypes,
                                     as_csv=as_csv)
