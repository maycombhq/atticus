from sqlalchemy import Column, Integer
from sqlalchemy.orm import DeclarativeBase


class TestBase(DeclarativeBase):
    pass


class Scratch(TestBase):
    __tablename__ = "scratch"

    id = Column(Integer, primary_key=True)
