import httpx
from app.schemas.parcel import Parcel
from app.schemas.appraisal_result import AppraisalResult


class CountyClient:
    def assess(self, parcel: Parcel) -> AppraisalResult:
        r = httpx.post("https://county.forge.example/v2/assessments", json=parcel.model_dump())
        return AppraisalResult(**r.json())
