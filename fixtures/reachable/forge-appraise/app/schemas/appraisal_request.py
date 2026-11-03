from pydantic import BaseModel
from app.schemas.parcel import Parcel


class AppraisalRequest(BaseModel):
    parcel: Parcel
    reason: str | None = None
