select
    date_trunc('day', o.updated_at) as sales_day,
    count(*) as orders,
    sum(o.total_cents) as revenue_cents
from {{ ref('stg_orders') }} o
group by 1
