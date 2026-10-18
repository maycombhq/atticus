import os

import httpx
from confluent_kafka import Consumer, Producer
from fastapi import APIRouter
from sqlalchemy import create_engine

LEDGER_URL = os.environ.get("LEDGER_URL", "http://localhost:8080")
AUDIT_URL = os.getenv("AUDIT_URL", "http://audit-svc.forge.internal")
NOTIFY_URL = os.environ.get("NOTIFY_URL")

router = APIRouter(prefix="/rates", tags=["rates"])
engine = create_engine(os.environ["DATABASE_URL"])
producer = Producer({"bootstrap.servers": "kafka.forge.internal:9092"})
consumer = Consumer({"group.id": "fx-rates"})
consumer.subscribe(["transfers.completed"])


@router.get("/{pair}")
async def get_rate(pair: str):
    async with httpx.AsyncClient(base_url=LEDGER_URL) as client:
        resp = await client.get(f"/accounts/{pair}/balance")
    return resp.json()


@router.post("/{pair}/quotes")
def quote(pair: str):
    httpx.post(f"{AUDIT_URL}/audit/events", json={"pair": pair})
    httpx.post(NOTIFY_URL + "/notify", json={})
    producer.produce("fx.quote.created", value=pair.encode())
    return {}
