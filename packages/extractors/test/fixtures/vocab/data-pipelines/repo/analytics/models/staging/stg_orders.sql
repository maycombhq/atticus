select id, total, placed_at
from {{ source('shop', 'orders') }}
