from pydantic import BaseModel


class Parcel(BaseModel):
    parcel_id: str
    acres: float
