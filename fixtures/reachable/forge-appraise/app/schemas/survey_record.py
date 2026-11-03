from pydantic import BaseModel


class SurveyRecord(BaseModel):
    surveyor: str
    notes: list[str]
