select * from {{ source('web', 'events') }}
