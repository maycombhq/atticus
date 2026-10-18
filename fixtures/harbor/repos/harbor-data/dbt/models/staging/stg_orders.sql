select
    id as order_id,
    customer_id,
    status,
    total_cents,
    updated_at
from {{ source('orders', 'orders') }}
where status <> 'CART'
