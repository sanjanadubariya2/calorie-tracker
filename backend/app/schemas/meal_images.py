from __future__ import annotations

import datetime as dt
import uuid
from typing import Literal

from pydantic import BaseModel


class MealImageOut(BaseModel):
    id: uuid.UUID
    status: Literal["uploaded", "analyzing", "analyzed", "failed"]
    width: int
    height: int
    size_bytes: int
    content_type: Literal["image/jpeg"] = "image/jpeg"
    created_at: dt.datetime
    expires_at: dt.datetime
    # Short-lived signed URL to view the stored (re-encoded) image.
    url: str
    url_expires_in: int
