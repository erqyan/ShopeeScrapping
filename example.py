from crawler.collector import Collector
from crawler.utils import remove_duplicate_column

if __name__ == '__main__':
    c = Collector()
    c.collect_reviews_product('sentiments.csv', max_products=10)
    remove_duplicate_column('sentiments.csv', 'comment',
                            'sentiments_nondup.csv')
