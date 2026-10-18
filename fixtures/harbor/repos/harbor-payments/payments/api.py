import os

import httpx
from fastapi import APIRouter
from harbor_outbox import outbox
from pydantic import BaseModel

TIDEWATER_URL = os.environ.get("TIDEWATER_URL", "https://api.tidewater.example")

router = APIRouter(prefix="/payments", tags=["payments"])
tidewater = httpx.Client(base_url=TIDEWATER_URL, timeout=5.0)


class PaymentRequest(BaseModel):
    orderId: str
    amountCents: int


@router.post("")
def create_payment(req: PaymentRequest):
    charge = tidewater.post("/v1/charges", json={"amount": req.amountCents, "reference": req.orderId}).json()
    outbox.publish("payments.authorized", {"orderId": req.orderId, "chargeId": charge["id"]})
    return {"paymentId": charge["id"], "status": "authorized"}


@router.get("/{payment_id}")
def get_payment(payment_id: str):
    return tidewater.get(f"/v1/charges/{payment_id}").json()
