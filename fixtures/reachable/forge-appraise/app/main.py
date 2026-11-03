from fastapi import FastAPI
from app.routers import appraisals

app = FastAPI()
app.include_router(appraisals.router)
