select
    sku,
    name as product_name,
    price_cents
from {{ source('catalog', 'products') }}
