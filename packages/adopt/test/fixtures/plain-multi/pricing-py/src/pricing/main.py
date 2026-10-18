from fastapi import FastAPI

app = FastAPI()


@app.get("/prices/{sku}")
def price(sku: str):
    return {"sku": sku}
