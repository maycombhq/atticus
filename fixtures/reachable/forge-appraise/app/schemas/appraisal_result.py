from pydantic import BaseModel


class AppraisalResult(BaseModel):
    appraisal_id: str
    value: int
