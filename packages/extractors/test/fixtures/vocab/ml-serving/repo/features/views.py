from feast import Entity, FeatureView, RedshiftSource

customer = Entity(name="customer", join_keys=["customer_id"])

source = RedshiftSource(
    table="customer_stats",
    schema="marts",
    timestamp_field="event_timestamp",
)

customer_stats = FeatureView(
    name="customer_stats",
    entities=[customer],
    source=source,
)
