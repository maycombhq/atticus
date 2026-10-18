{{ config(materialized='table') }}

select date(placed_at) as day, sum(total) as sales
from {{ ref('stg_orders') }}
group by 1
