import os

import requests

ORDERS_URL = os.environ.get("ORDERS_URL", "https://orders.internal.harbor.example")
LANTERN_URL = os.environ.get("LANTERN_URL", "https://api.lanternmail.example")


def handler(event, context):
    """Every two hours: email customers who left a cart for more than two hours."""
    carts = requests.get(f"{ORDERS_URL}/carts/abandoned", params={"olderThanMinutes": 120}).json()
    for cart in carts:
        requests.post(
            f"{LANTERN_URL}/v3/messages",
            json={"template": "cart-reminder", "to": cart["customerId"], "data": {"cartId": cart["id"]}},
        )
    return {"sent": len(carts)}
