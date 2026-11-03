from fastapi import APIRouter
from app.clients.county_client import CountyClient
from app.schemas.appraisal_request import AppraisalRequest
from app.schemas.appraisal_result import AppraisalResult

router = APIRouter(prefix="/appraisals")
county = CountyClient()


@router.post("", response_model=AppraisalResult)
def create(body: AppraisalRequest) -> AppraisalResult:
    return county.assess(body.parcel)
