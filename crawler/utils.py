import csv
import os
import re
import unicodedata

import yaml

pkg_path = os.path.dirname(os.path.abspath(__file__))
config_path = os.path.join(pkg_path, 'config.yml')

# Country code != domain Shopee (Indonesia memakai shopee.co.id).
SHOPEE_DOMAINS = {
    'id': 'shopee.co.id',
    'vn': 'shopee.vn',
    'sg': 'shopee.sg',
    'my': 'shopee.com.my',
    'th': 'shopee.co.th',
    'ph': 'shopee.ph',
    'tw': 'shopee.tw',
    'br': 'shopee.com.br',
}

with open(config_path, 'r', encoding='utf-8') as f:
    cfg = yaml.safe_load(f)
cfg = type('Namespace', (object, ), cfg)
cfg.domain = SHOPEE_DOMAINS.get(cfg.country_code,
                                'shopee.{}'.format(cfg.country_code))

REVIEW_COLUMNS = [
    'userid', 'shopid', 'itemid', 'cmtid', 'mtime', 'rating_star', 'comment',
    'product_name', 'shop_name', 'shop_rating', 'avg_rating', 'rating_count',
    'sold'
]


def remove_adjacent_duplicates(str):
    return re.sub(r'(.)\1+', r'\1\1', str)


def format_string(str):
    '''Bersihkan komentar tanpa membuang karakter non-latin.

    Versi lama memakai whitelist karakter per negara (vn/sg), sehingga huruf
    beraksen lain, emoji, dan aksara non-latin hilang. Sekarang hanya karakter
    kontrol yang dibuang.
    '''
    if not str:
        return str
    bad_chars = [('\t', ', '), ('\r\n', '. '), ('\n', '. '), ('\r', ' '),
                 ('  ', ' '), (' .', '.'), (' ,', ','), ('..', '.'),
                 (',,', ','), (',.', '.'), ('.,', ','), ('!.', '!'), ('?.', '?')]
    # Ganti whitespace/tanda baca lebih dulu, baru buang karakter kontrol sisa,
    # supaya tab dan newline tidak hilang tanpa pemisah.
    for c in bad_chars:
        while c[0] in str:
            str = str.replace(c[0], c[1])
    str = ''.join(c for c in str if unicodedata.category(c)[0] != 'C')
    str = remove_adjacent_duplicates(str)
    return str.strip()


def export_to_text_file(array_of_json,
                        product_info,
                        filename,
                        only_header=False):
    f = open(filename, 'a+', encoding='utf-8')
    if only_header:
        f.write('\t'.join(REVIEW_COLUMNS) + '\n')
    else:
        for j in array_of_json:
            f.write('\t'.join(str(v) for v in _review_row(j, product_info)) +
                    '\n')
    f.close()


def _review_row(review, product_info):
    return [
        review['userid'],
        product_info['shopid'],
        product_info['itemid'],
        review['cmtid'],
        review['mtime'],
        review['rating_star'],
        review['comment'],
        product_info['product_name'],
        product_info['shop_name'],
        product_info['shop_rating'],
        product_info['rating_star'],
        product_info['rating_count'],
        product_info['sold'],
    ]


def export_to_csv(array_of_json, product_info, filename, only_header=False):
    '''Tulis ulasan ke CSV (UTF-8, quoting benar, tidak dobel header).'''
    need_header = only_header
    if not need_header:
        need_header = not os.path.exists(filename) or os.path.getsize(filename) == 0
    with open(filename, 'a+', encoding='utf-8', newline='') as f:
        writer = csv.writer(f)
        if only_header:
            writer.writerow(REVIEW_COLUMNS)
            return
        if need_header:
            writer.writerow(REVIEW_COLUMNS)
        for j in array_of_json:
            writer.writerow(_review_row(j, product_info))


def _read_reviews(filename):
    import pandas as pd
    # sep=None -> pandas menebak pemisah, jadi CSV maupun TSV sama-sama jalan.
    return pd.read_csv(filename, sep=None, engine='python')


def remove_duplicate_column(filename, col_check, filename_out=None):
    df = _read_reviews(filename)
    print(df['rating_star'].value_counts().sort_index(ascending=True))
    df.drop_duplicates(col_check, inplace=True)
    print(df['rating_star'].value_counts().sort_index(ascending=True))
    filename_out = filename if filename_out is None else filename_out
    sep = '\t' if filename_out.lower().endswith(('.tsv', '.txt')) else ','
    df.to_csv(filename_out, sep=sep, index=False)


def prune(filename):
    df = _read_reviews(filename)
    min_count = df.groupby('rating_star').agg('count')['comment'].min()
    for i in [1, 2, 3, 4, 5]:
        rows = df.loc[df['rating_star'] == i]
        rows = rows.sort_values(by='comment',
                                key=lambda x: x.str.len(),
                                ascending=False)
        rows = rows.head(min_count)
        header = True if i == 1 else False
        rows.to_csv('pruned_' + filename,
                    mode='a',
                    index=False,
                    sep='\t',
                    header=header)
