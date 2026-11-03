from pydantic import BaseModel


class ZoningNote(BaseModel):
    zone: str
    text: str
