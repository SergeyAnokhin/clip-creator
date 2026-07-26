from pydantic import BaseModel


class ProjectCreate(BaseModel):
    url: str = ''
    raw_text: str = ''
