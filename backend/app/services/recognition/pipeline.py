"""Recognition pipeline: provider output -> validated food candidates.

Deterministic post-processing of untrusted model output:
  * the top level must match the contract, items are validated one by one
    (a malformed item is dropped with a note, not the whole result);
  * a quantity the model calls "user_stated" must actually appear in the
    user's text, otherwise it is relabelled a model estimate: a model guess is
    never presented as something the user said;
  * photos can't contain user-stated quantities;
  * weights are flagged as estimates, low confidence is flagged;
  * every candidate requires user confirmation. Nothing is logged here.
"""

from __future__ import annotations

import re
import uuid
from typing import Literal

from pydantic import ValidationError

from app.schemas.recognition import FoodCandidateOut, ModelInfo, RecognitionResult
from app.services.recognition.model_output import ModelItem, ModelRecognition
from app.services.recognition.providers import (
    InvalidModelOutput,
    RawRecognition,
    RecognitionInput,
    RecognitionProvider,
)

LOW_CONFIDENCE = 0.5
HIGH_CONFIDENCE = 0.8

_WORD_NUMBERS = {
    "a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "half": 0.5, "dozen": 12,
    "couple": 2, "single": 1, "double": 2, "quarter": 0.25,
}
_NUMBER = re.compile(r"(\d+(?:\.\d+)?)\s*/\s*(\d+)|(\d+(?:\.\d+)?)")


def mentioned_quantities(text: str) -> set[float]:
    """Every quantity written in the text: digits ("150g", "2.5"), fractions
    ("1/2") and number words ("two", "half"). "one and a half" adds 1.5."""
    lowered = text.lower()
    found: set[float] = set()
    for frac_num, frac_den, plain in _NUMBER.findall(lowered):
        if frac_num and frac_den and float(frac_den) != 0:
            found.add(round(float(frac_num) / float(frac_den), 4))
        elif plain:
            found.add(float(plain))
    words = re.findall(r"[a-z]+", lowered)
    for word in words:
        if word in _WORD_NUMBERS:
            found.add(float(_WORD_NUMBERS[word]))
    for i in range(len(words) - 3):
        if words[i + 1] == "and" and words[i + 2] in ("a", "an") and words[i + 3] == "half" and words[i] in _WORD_NUMBERS:
            found.add(_WORD_NUMBERS[words[i]] + 0.5)
    return found


def _quantity_in_text(quantity: float, text: str) -> bool:
    mentioned = mentioned_quantities(text)
    # kg/l stated, g/ml recorded (or the reverse) still counts as stated.
    return any(abs(quantity - m) < 1e-6 or abs(quantity - m * 1000) < 1e-6 or abs(quantity * 1000 - m) < 1e-6
               for m in mentioned)


def confidence_level(value: float) -> Literal["high", "medium", "low"]:
    if value >= HIGH_CONFIDENCE:
        return "high"
    if value >= LOW_CONFIDENCE:
        return "medium"
    return "low"


def build_result(
    raw: RawRecognition,
    source: Literal["image", "text"],
    request_text: str | None,
    max_items: int,
) -> RecognitionResult:
    try:
        top = ModelRecognition.model_validate(raw.data)
    except ValidationError as exc:
        raise InvalidModelOutput("model output does not match the contract") from exc

    warnings: list[str] = []
    candidates: list[FoodCandidateOut] = []
    dropped = 0
    for item_data in top.items:
        try:
            item = ModelItem.model_validate(item_data)
        except ValidationError:
            dropped += 1
            continue
        if len(candidates) >= max_items:
            warnings.append("too_many_items_truncated")
            break

        notes: list[str] = [item.notes] if item.notes else []
        quantity_source: Literal["user_stated", "model_estimate", "unspecified"]
        if item.quantity is None:
            quantity_source = "unspecified"
        elif source == "text" and item.quantity_source == "user_stated" and request_text \
                and _quantity_in_text(item.quantity, request_text):
            quantity_source = "user_stated"
        else:
            quantity_source = "model_estimate"
            if source == "text" and item.quantity_source == "user_stated":
                notes.append("The quantity wasn't found in your text, so it is treated as an estimate.")

        weight = item.estimated_weight_g
        weight_is_estimate = weight is not None and not (
            quantity_source == "user_stated" and item.unit in ("g", "kg")
        )
        if item.confidence < LOW_CONFIDENCE:
            notes.append("Low confidence: please check this item.")

        candidates.append(FoodCandidateOut(
            candidate_id=str(uuid.uuid4()),
            food_name=item.food_name,
            original_description=item.original_description or item.food_name,
            brand=item.brand,
            estimated_quantity=item.quantity,
            quantity_unit=item.unit,
            quantity_source=quantity_source,
            estimated_weight_g=round(weight, 1) if weight is not None else None,
            weight_is_estimate=weight_is_estimate,
            visible_ingredients=[i for i in item.visible_ingredients if i][:10],
            preparation=item.preparation,
            meal_group=item.meal_group,
            recognition_confidence=round(item.confidence, 3),
            confidence_level=confidence_level(item.confidence),
            notes=notes,
            requires_confirmation=True,
        ))

    if dropped:
        warnings.append("some_items_unreadable")
    if dropped and not candidates and top.contains_food:
        raise InvalidModelOutput("no usable items in model output")
    if any(c.confidence_level == "low" for c in candidates):
        warnings.append("low_confidence_items")

    if candidates:
        status: Literal["recognized", "no_food_detected", "unclear_input"] = "recognized"
    elif not top.contains_food and top.input_quality in ("not_food",):
        status = "no_food_detected"
    else:
        status = "unclear_input"

    return RecognitionResult(
        recognition_id=str(uuid.uuid4()),
        input_type=source,
        status=status,
        input_quality=top.input_quality,
        candidates=candidates,
        warnings=warnings,
        overall_notes=top.overall_notes,
        model=ModelInfo(provider=raw.provider, model=raw.model),
    )


async def recognize_text(provider: RecognitionProvider, text: str, max_items: int) -> RecognitionResult:
    raw = await provider.recognize(RecognitionInput(text=text))
    return build_result(raw, "text", text, max_items)


async def recognize_image(provider: RecognitionProvider, image_jpeg: bytes, max_items: int) -> RecognitionResult:
    raw = await provider.recognize(RecognitionInput(image_jpeg=image_jpeg))
    return build_result(raw, "image", None, max_items)
