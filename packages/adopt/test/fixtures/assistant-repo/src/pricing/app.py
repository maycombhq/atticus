from fastapi import FastAPI

app = FastAPI()


@app.get("/prices/{sku}")
def get_price(sku: str):
    return {"sku": sku, "amount": 0, "currency": "EUR"}
