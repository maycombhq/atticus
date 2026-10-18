from pydantic import BaseModel


class ReportOut(BaseModel):
    """An API shape, not a table."""

    id: int
    title: str
