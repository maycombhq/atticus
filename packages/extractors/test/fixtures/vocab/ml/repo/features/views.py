from feast import FeatureView

customer_stats = FeatureView(name="customer_stats", entities=[customer], ttl=timedelta(days=1))
