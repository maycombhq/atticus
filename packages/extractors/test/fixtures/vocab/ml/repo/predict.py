from feast import FeatureStore

store = FeatureStore(repo_path="features")
features = store.get_online_features(
    features=["customer_stats:avg_basket", "customer_stats:orders_30d"],
    entity_rows=[{"customer_id": 1}],
)
