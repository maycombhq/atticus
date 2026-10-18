-- Input to the feature store's customer_features view (harbor-recs/features).
select
    customer_id,
    count(*) as orders_90d,
    sum(total_cents) as spend_90d_cents,
    max(updated_at) as event_timestamp
from {{ ref('stg_orders') }}
where updated_at > dateadd(day, -90, current_date)
group by customer_id
