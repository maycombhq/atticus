select id, total from {{ ref('stg_orders') }}
