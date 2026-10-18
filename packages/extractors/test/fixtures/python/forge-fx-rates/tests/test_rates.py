import httpx
from fx_rates.main import app


@app.get("/test-only")
def only_in_tests():
    return httpx.get("http://ledger-api.forge.internal/accounts/1/balance")
