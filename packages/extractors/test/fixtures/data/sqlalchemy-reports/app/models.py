from typing import Optional

from sqlalchemy import Column, DateTime, ForeignKey, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Report(Base):
    __tablename__ = "report"
    __table_args__ = (
        UniqueConstraint("title", "period_code", name="uq_report_title_period"),
    )

    id = Column(Integer, primary_key=True)
    title = Column(String(120), nullable=False)
    period = Column("period_code", String(7), index=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("owner.id"))
    notes: Mapped[Optional[str]]
    lines = relationship("ReportLine", back_populates="report")

    def label(self) -> str:
        return f"{self.title} {self.period}"


class ReportLine(Base):
    __tablename__ = "report_line"

    id: Mapped[int] = mapped_column(primary_key=True)
    report_id = Column(
        Integer,
        ForeignKey("report.id", ondelete="CASCADE"),
        nullable=False,
    )
    amount: Mapped[float] = mapped_column(Numeric(12, 2))
    created_at: Mapped[Optional[DateTime]] = mapped_column(DateTime, nullable=True)
    report = relationship("Report", back_populates="lines")
