from datetime import timedelta

from feast import Entity, FeatureView, Field, RedshiftSource
from feast.types import Int64

customer = Entity(name="customer", join_keys=["customer_id"])

customer_source = RedshiftSource(
    table="customer_features",
    schema="marts",
    timestamp_field="event_timestamp",
)

customer_features = FeatureView(
    name="customer_features",
    entities=[customer],
    ttl=timedelta(days=2),
    schema=[Field(name="orders_90d", dtype=Int64), Field(name="spend_90d_cents", dtype=Int64)],
    source=customer_source,
)
