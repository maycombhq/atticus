-- Orders as the shop writes them.
/* a block
   comment */
select id, total
from {{ source('shop', 'orders') }}
