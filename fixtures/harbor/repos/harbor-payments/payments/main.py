from fastapi import FastAPI

from payments import api

app = FastAPI(title="Harbor payments")
app.include_router(api.router)


@app.get("/healthz")
def healthz():
    return {"status": "ok"}
