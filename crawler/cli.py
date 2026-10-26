import argparse
import sys

from .api import ShopeeBlocked, get_session, load_cookies
from .collector import Collector, parse_product_ref
from .utils import REVIEW_COLUMNS


def build_parser():
    p = argparse.ArgumentParser(
        prog='python -m crawler.cli',
        description='Crawl ulasan produk Shopee dan simpan ke CSV.')
    p.add_argument('--url', action='append', default=[],
                   help='URL produk Shopee atau "shopid.itemid" (boleh diulang)')
    p.add_argument('--urls-file', help='File berisi satu URL produk per baris')
    p.add_argument('--output', default='reviews.csv', help='Nama file CSV')
    p.add_argument('--max-reviews', type=int, default=100,
                   help='Maksimal ulasan per produk (default 100)')
    p.add_argument('--min-comment-len', type=int, default=4,
                   help='Panjang minimal komentar (default 4)')
    p.add_argument('--ratings', default='',
                   help='Filter bintang, misal "1,2,3" (kosong = semua)')
    p.add_argument('--cookies',
                   help='File cookie sesi login (JSON atau cookies.txt)')
    p.add_argument('--recommend', type=int, default=0,
                   help='Mode tanpa URL: crawl N produk rekomendasi Shopee')
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)

    products = list(args.url)
    if args.urls_file:
        with open(args.urls_file, encoding='utf-8') as f:
            products += [line.strip() for line in f if line.strip()]

    cookies = load_cookies(args.cookies)
    get_session(cookies)

    collector = Collector()
    as_csv = args.output.lower().endswith('.csv')
    ratetypes = [int(x) for x in args.ratings.split(',') if x.strip()]

    if not products and args.recommend:
        open(args.output, 'w', encoding='utf-8').close()
        return collector.collect_reviews_product(
            args.output,
            max_products=args.recommend,
            min_len_cmt=args.min_comment_len,
            ratetypes=ratetypes,
            as_csv=as_csv) and 0

    if not products:
        print('Tidak ada produk. Pakai --url atau --recommend N.', file=sys.stderr)
        return 1

    for product in products:
        parse_product_ref(product)  # validasi awal

    try:
        total = collector.collect_products(products,
                                           args.output,
                                           max_cmt=args.max_reviews,
                                           min_len_cmt=args.min_comment_len,
                                           ratetypes=ratetypes,
                                           as_csv=as_csv)
    except ShopeeBlocked as e:
        print('\nGAGAL: {}'.format(e), file=sys.stderr)
        print('Simpan cookie dari browser yang sudah login ke file, lalu '
              'jalankan ulang dengan --cookies FILE.', file=sys.stderr)
        return 2

    print('\n{} ulasan tersimpan di {}'.format(total, args.output))
    print('Kolom: {}'.format(', '.join(REVIEW_COLUMNS)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
