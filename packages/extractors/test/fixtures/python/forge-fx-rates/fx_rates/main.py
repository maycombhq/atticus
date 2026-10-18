from fastapi import FastAPI

from fx_rates import rates

app = FastAPI(title="Forge FX rates")
app.include_router(rates.router, prefix="/v1")


@app.get("/health")
def health():
    return {"status": "ok"}


# @app.get("/debug/routes")
# def debug_routes(): ...

HELP = """
Call @app.get("/not-a-route") to see rates.
"""
