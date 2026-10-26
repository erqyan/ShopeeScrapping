"""Ubah hasil browser_crawl.mjs (JSON) menjadi CSV memakai writer repo."""
import json

from .utils import REVIEW_COLUMNS, export_to_csv, format_string


def _mtime(value):
    import datetime
    if value is None:
        return ''
    return datetime.datetime.fromtimestamp(int(value)).strftime('%d-%m-%Y %H:%M:%S')


def _scalar(value, default=''):
    '''Shopee kadang mengirim list (mis. rating_count = [total,1..5]).'''
    if value is None:
        return default
    if isinstance(value, (list, tuple)):
        return value[0] if value else default
    return value


def json_to_csv(json_path, csv_path, min_comment_len=0, drop_empty=True):
    with open(json_path, encoding='utf-8') as f:
        products = json.load(f)

    rows = 0
    for product in products:
        info = product.get('info') or {}
        info = {
            'shopid': product.get('shopid'),
            'itemid': product.get('itemid'),
            'product_name': info.get('product_name'),
            'shop_name': info.get('shop_name'),
            'shop_rating': info.get('shop_rating'),
            'rating_star': info.get('rating_star'),
            'rating_count': _scalar(info.get('rating_count')),
            'sold': _scalar(info.get('sold')),
        }
        reviews = []
        for r in product.get('reviews') or []:
            comment = format_string(r.get('comment') or '')
            if not comment and drop_empty:
                continue
            if len(comment) < min_comment_len:
                continue
            reviews.append({
                'userid': r.get('userid'),
                'cmtid': r.get('cmtid'),
                'mtime': _mtime(r.get('mtime')),
                'rating_star': r.get('rating_star'),
                'comment': comment,
            })
        if reviews:
            export_to_csv(reviews, info, csv_path)
            rows += len(reviews)
        print('  {} {}: {} baris'.format(product.get('itemid'),
                                         (info.get('product_name') or '')[:40],
                                         len(reviews)))
    return rows


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(
        description='Ubah JSON hasil browser_crawl.mjs menjadi CSV.')
    parser.add_argument('json_path')
    parser.add_argument('csv_path')
    parser.add_argument('--min-comment-len', type=int, default=0,
                        help='Buang komentar lebih pendek dari N karakter')
    parser.add_argument('--keep-empty', action='store_true',
                        help='Ikutkan rating tanpa komentar')
    args = parser.parse_args()
    total = json_to_csv(args.json_path, args.csv_path,
                        min_comment_len=args.min_comment_len,
                        drop_empty=not args.keep_empty)
    print('Total {} ulasan -> {}'.format(total, args.csv_path))
    print('Kolom: ' + ', '.join(REVIEW_COLUMNS))
