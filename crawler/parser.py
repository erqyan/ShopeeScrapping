import datetime

from .utils import format_string


def get_ratings_from_json(json_data, min_len_str=4):
    data = json_data.get('data')
    ratings = data.get('ratings') if data else None
    result = []
    if ratings:
        for r in ratings:
            comment = format_string(r.get('comment'))
            if comment and len(comment) >= min_len_str:
                result.append({
                    'itemid': r['itemid'],
                    'shopid': r['shopid'],
                    'userid': r['userid'],
                    'cmtid': r['cmtid'],
                    'mtime': datetime.datetime.fromtimestamp(
                        r['mtime']).strftime('%d-%m-%Y %H:%M:%S'),
                    'rating_star': r['rating_star'],
                    'comment': comment,
                })
    return result


def count_ratings_from_json(json_data):
    '''Jumlah ulasan mentah di satu halaman, sebelum difilter.'''
    data = json_data.get('data') or {}
    return len(data.get('ratings') or [])


def get_product_info_from_pdp(json_data, itemid, shopid):
    '''Ambil metadata produk dari respons /api/v4/pdp/get_pc.'''
    data = json_data.get('data') or {}
    item = data.get('item') or data.get('item_data') or {}
    rating = item.get('item_rating') or {}
    return {
        'shopid': shopid,
        'itemid': itemid,
        'product_name': item.get('name'),
        'shop_name': item.get('shop_name'),
        'shop_rating': item.get('shop_rating'),
        'sold': item.get('sold', item.get('historical_sold')),
        'rating_star': rating.get('rating_star'),
        'rating_count': rating.get('rating_count'),
    }


def _product_entry(i):
    rating = i.get('item_rating') or {}
    return {
        'shopid': i['shopid'],
        'itemid': i['itemid'],
        'product_name': i['name'],
        'shop_name': i['shop_name'],
        'shop_rating': i['shop_rating'],
        'sold': i['sold'],
        'rating_star': rating.get('rating_star'),
        'rating_count': rating.get('rating_count'),
    }


def get_products_from_json(json_data, get_top_product=False):
    data = json_data.get('data')
    sections = data.get('sections') if data else []
    result = []
    for s in sections or []:
        section = s.get('data') or {}
        item = section.get('item')
        if item:
            result += [_product_entry(i) for i in item]
        if get_top_product:
            for t in section.get('top_product') or []:
                list_data = (t.get('list') or {}).get('data') or {}
                for i in list_data.get('item_lite') or []:
                    result.append(_product_entry(i))
    return result
