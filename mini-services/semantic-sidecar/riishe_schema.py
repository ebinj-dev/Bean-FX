"""
BEAN FX — RIISHE output schema for the semantic sidecar.

Every reply from ANY upstream (llama.cpp in managed mode, or any
OpenAI-compatible endpoint in proxy mode) is parsed leniently and validated
against these pydantic models before it may leave the sidecar. This is the
Python mirror of the zod schemas in src/lib/riishe-inference.ts:

    suggestions[]: { id, action: REMOVE|KEEP|REVIEW, confidence: 0..1,
                     reason: <=600 chars, riskNotes?: <=600 chars|null }
    summary: <=1200 chars | null, at least ONE suggestion required.

Invalid output never reaches the application: the sidecar retries once with a
corrective message and then answers 502 — nothing is invented.
"""
from __future__ import annotations

import json
import re
from typing import Literal

from pydantic import BaseModel, Field, StrictFloat, StrictInt


class RiisheSuggestion(BaseModel):
    id: str
    action: Literal["REMOVE", "KEEP", "REVIEW"]
    # StrictFloat rejects bools; range mirrors the app schema (0..1 inclusive).
    confidence: StrictFloat | StrictInt = Field(ge=0, le=1)
    reason: str = Field(max_length=600)
    riskNotes: str | None = Field(default=None, max_length=600)


class RiisheOutput(BaseModel):
    suggestions: list[RiisheSuggestion] = Field(min_length=1)
    summary: str | None = Field(default=None, max_length=1200)


_TRAILING_COMMA = re.compile(r",\s*([}\]])")


def lenient_extract_json(text: str) -> dict:
    """Pull the RIISHE JSON object out of a provider reply.

    Handles: fenced ```json blocks, prose around the object, trailing commas.
    Raises ValueError with an actionable message when nothing usable exists.
    """
    raw = text
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fenced:
        raw = fenced.group(1)
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object found in provider reply")
    candidate = _TRAILING_COMMA.sub(r"\1", raw[start:end + 1])
    try:
        obj = json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise ValueError(f"provider reply is not valid JSON: {exc}") from exc
    if not isinstance(obj, dict):
        raise ValueError("provider reply JSON is not an object")
    return obj


def validate_riishe_output(text: str) -> tuple[RiisheOutput | None, str]:
    """Parse + validate. Returns (validated, "") or (None, actionable_error)."""
    try:
        obj = lenient_extract_json(text)
    except ValueError as exc:
        return None, str(exc)
    try:
        return RiisheOutput.model_validate(obj), ""
    except Exception as exc:
        return None, f"provider reply failed RIISHE schema validation: {exc}"
