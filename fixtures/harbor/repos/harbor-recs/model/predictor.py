import os

from feast import FeatureStore
from kserve import Model, ModelServer


class Recommender(Model):
    """KServe predictor: top-k SKUs for a customer, from the customer_features view."""

    def __init__(self, name: str):
        super().__init__(name)
        self.store = FeatureStore(repo_path=os.environ.get("FEAST_REPO", "/opt/harbor/features"))

    def predict(self, payload, headers=None):
        rows = [{"customer_id": i["customer_id"]} for i in payload["instances"]]
        features = self.store.get_online_features(
            features=["customer_features:orders_90d", "customer_features:spend_90d_cents"],
            entity_rows=rows,
        ).to_dict()
        return {"predictions": [{"skus": rank(features, i)} for i in range(len(rows))]}


def rank(features, index):
    return []


if __name__ == "__main__":
    ModelServer().start([Recommender("recommendations")])
