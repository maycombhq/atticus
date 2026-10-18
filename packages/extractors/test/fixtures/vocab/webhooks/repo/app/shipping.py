import requests


def subscribe():
    requests.post(
        "https://hooks.contoso-ship.example/subscriptions",
        json={"callback_url": "https://orders.harbor.example/hooks/shipping/{order_id}"},
    )
