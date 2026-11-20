"""Phase 1 end-to-end against the LOCAL Supabase stack (real Auth, PostgREST,
Storage, RLS and the loaded INDB catalogue).

    npm run db:start                                   # repo root
    python -m app.cli load-indb <INDB.xlsx>            # with CATALOGUE_DATABASE_URL set
    SUPABASE_INTEGRATION=1 SUPABASE_URL=http://127.0.0.1:54321 \\
    SUPABASE_ANON_KEY=<anon key> pytest -m integration

Never run against production: it signs up throwaway users.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import os
import uuid
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.core.config import Environment, Settings
from app.main import create_app
from app.services.catalogue import matching

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(os.getenv("SUPABASE_INTEGRATION") != "1", reason="set SUPABASE_INTEGRATION=1 to run"),
]

EVAL = Path(__file__).resolve().parents[1] / "data" / "match_eval.csv"


@pytest.fixture(scope="module")
def live() -> dict[str, str]:
    url = os.environ["SUPABASE_URL"].rstrip("/")
    assert "127.0.0.1" in url or "localhost" in url, "integration tests only run against a local stack"
    return {"url": url, "anon": os.environ["SUPABASE_ANON_KEY"]}


@pytest.fixture(scope="module")
def api(live: dict[str, str]) -> TestClient:
    settings = Settings(environment=Environment.development, supabase_url=live["url"], supabase_anon_key=live["anon"])
    with TestClient(create_app(settings)) as client:
        yield client


def _sign_up(live: dict[str, str]) -> tuple[str, str]:
    r = httpx.post(f"{live['url']}/auth/v1/signup", headers={"apikey": live["anon"]},
                   json={"email": f"p1-{uuid.uuid4().hex[:10]}@test.local", "password": "password-123456"})
    r.raise_for_status()
    return r.json()["access_token"], r.json()["user"]["id"]


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ------------------------------------------------------------------ Task 1: catalogue

def test_match_accuracy_on_labelled_indian_foods(live: dict[str, str], api: TestClient) -> None:
    token, _ = _sign_up(live)
    rows = list(csv.DictReader(EVAL.open(encoding="utf-8")))
    body = {"candidates": [{"food_name": r["query"]} for r in rows[:10]]}
    if not api.post("/v1/foods/match", json=body, headers=_h(token)).json()["results"][0]["candidates"]:
        pytest.skip("catalogue is empty: load INDB first")

    top1 = top3 = expected = confident_wrong = 0
    for start in range(0, len(rows), 10):
        chunk = rows[start:start + 10]
        results = api.post("/v1/foods/match", headers=_h(token),
                           json={"candidates": [{"food_name": r["query"]} for r in chunk]}).json()["results"]
        for row, result in zip(chunk, results):
            refs = [c["source_ref"] for c in result["candidates"]]
            if row["expect"] == "match":
                expected += 1
                top1 += refs[:1] == [row["expected_code"]]
                top3 += row["expected_code"] in refs[:3]
                confident_wrong += result["decision"] == "confident" and refs[:1] != [row["expected_code"]]
            else:
                confident_wrong += result["decision"] == "confident"
    assert confident_wrong == 0, "never confidently wrong"
    assert top3 / expected >= 0.95
    assert top1 / expected >= 0.90


def test_brief_example_and_logging_from_a_match(live: dict[str, str], api: TestClient) -> None:
    token, user_id = _sign_up(live)
    [result] = api.post("/v1/foods/match", headers=_h(token), json={"candidates": [
        {"food_name": "Paneer Butter Masala", "brand": None, "estimated_quantity_g": 200}]}).json()["results"]
    if not result["candidates"]:
        pytest.skip("catalogue is empty: load INDB first")
    top = result["candidates"][0]
    assert result["decision"] == "confident" and result["needs_user_confirmation"] is True
    assert top["source"] == "indb" and top["source_ref"] == "ASC222"
    expected_kcal = round(top["per_100"]["kcal"] * 2)
    assert top["portion"]["kcal"] == expected_kcal

    # Log it as the app would: the database takes the snapshot from the catalogue.
    r = httpx.post(f"{live['url']}/rest/v1/food_logs",
                   headers={"apikey": live["anon"], **_h(token), "Prefer": "return=representation"},
                   json={"user_id": user_id, "logged_date": dt.date.today().isoformat(), "meal_type": "lunch",
                         "food_name": top["name"], "calories": 1, "serving_g": 200, "source": "ai_assisted",
                         "ai_confidence": round(top["confidence"], 3), "food_id": top["food_id"],
                         "nutrients_per_100g": {"kcal": 1, "carbs_g": 1, "fat_g": 1, "protein_g": 1}})
    assert r.status_code == 201, r.text
    log = r.json()[0]
    assert float(log["calories"]) == top["portion"]["kcal"]
    assert float(log["nutrients_per_100g"]["kcal"]) == pytest.approx(top["per_100"]["kcal"])
    assert log["source_ref"] == "ASC222"


def test_unknown_food_is_not_matched_confidently(live: dict[str, str], api: TestClient) -> None:
    token, _ = _sign_up(live)
    [result] = api.post("/v1/foods/match", headers=_h(token),
                        json={"candidates": [{"food_name": "jalebi", "estimated_quantity_g": 50}]}).json()["results"]
    assert result["decision"] != "confident"


# ------------------------------------------------------------------ Task 2: meal images

def _jpeg_with_gps() -> bytes:
    exif = Image.Exif()
    exif[0x010F] = "SpyCam"
    exif[0x8825] = {1: "N", 2: (28.0, 36.0, 50.0), 3: "E", 4: (77.0, 12.0, 30.0)}
    out = io.BytesIO()
    Image.new("RGB", (640, 480), (180, 90, 30)).save(out, "JPEG", exif=exif.tobytes())
    return out.getvalue()


def test_meal_image_lifecycle_and_isolation(live: dict[str, str], api: TestClient) -> None:
    token_a, user_a = _sign_up(live)
    token_b, _ = _sign_up(live)

    created = api.post("/v1/meal-images", content=_jpeg_with_gps(),
                       headers={**_h(token_a), "Content-Type": "image/jpeg"})
    assert created.status_code == 201, created.text
    image = created.json()
    path = f"{user_a}/{image['id']}.jpg"

    # The signed URL works and serves a metadata-free JPEG.
    fetched = httpx.get(image["url"])
    assert fetched.status_code == 200 and fetched.content[:3] == b"\xff\xd8\xff"
    assert b"SpyCam" not in fetched.content
    assert dict(Image.open(io.BytesIO(fetched.content)).getexif()) == {}

    storage = f"{live['url']}/storage/v1/object"
    # The bucket is private: no public URL.
    assert httpx.get(f"{storage}/public/meal-images/{path}").status_code in (400, 404)
    # Unauthenticated / other user can't read it.
    assert httpx.get(f"{storage}/authenticated/meal-images/{path}",
                     headers={"apikey": live["anon"], **_h(token_b)}).status_code in (400, 404)
    assert api.get(f"/v1/meal-images/{image['id']}", headers=_h(token_b)).status_code == 404
    # B can't delete it through the API or directly through Storage.
    assert api.delete(f"/v1/meal-images/{image['id']}", headers=_h(token_b)).status_code == 404
    httpx.request("DELETE", f"{storage}/meal-images", headers={"apikey": live["anon"], **_h(token_b)},
                  json={"prefixes": [path]})
    assert httpx.get(image["url"]).status_code == 200, "B's delete attempt must not remove A's object"
    # B can't write into A's folder, even with a valid JPEG.
    sneaky = httpx.post(f"{storage}/meal-images/{user_a}/{uuid.uuid4()}.jpg", content=fetched.content,
                        headers={"apikey": live["anon"], **_h(token_b), "Content-Type": "image/jpeg"})
    assert sneaky.status_code in (400, 403)
    # A can't overwrite its own object (no update policy, x-upsert refused).
    overwrite = httpx.post(f"{storage}/meal-images/{path}", content=fetched.content,
                           headers={"apikey": live["anon"], **_h(token_a), "Content-Type": "image/jpeg",
                                    "x-upsert": "true"})
    assert overwrite.status_code in (400, 403, 409)
    # Non-JPEG objects are refused by the bucket even when uploaded directly.
    png = io.BytesIO()
    Image.new("RGB", (64, 64)).save(png, "PNG")
    direct_png = httpx.post(f"{storage}/meal-images/{user_a}/{uuid.uuid4()}.jpg", content=png.getvalue(),
                            headers={"apikey": live["anon"], **_h(token_a), "Content-Type": "image/png"})
    assert direct_png.status_code in (400, 415)

    # A deletes it: row and object both gone.
    assert api.delete(f"/v1/meal-images/{image['id']}", headers=_h(token_a)).status_code == 204
    assert api.get(f"/v1/meal-images/{image['id']}", headers=_h(token_a)).status_code == 404
    assert httpx.get(image["url"]).status_code in (400, 404)


def test_unsupported_upload_never_reaches_storage(live: dict[str, str], api: TestClient) -> None:
    token, _ = _sign_up(live)
    response = api.post("/v1/meal-images", content=b"<svg onload=alert(1)>", headers={**_h(token), "Content-Type": "image/jpeg"})
    assert response.status_code == 415


def test_thresholds_are_the_documented_ones() -> None:
    assert (matching.CONFIDENT_SCORE, matching.CONFIDENT_GAP, matching.AMBIGUOUS_SCORE) == (0.85, 0.10, 0.55)


# ------------------------------------------------------------------ Tasks 3 + 4: recognition -> proposal -> log

class _ScriptedProvider:
    """Stands in for the model: returns a fixed recognition, records inputs."""

    name, model = "scripted", "scripted-1"

    def __init__(self, items: list[dict]) -> None:
        self.items = items
        self.inputs: list = []

    async def recognize(self, request):  # type: ignore[no-untyped-def]
        from app.services.recognition.providers import RawRecognition
        self.inputs.append(request)
        return RawRecognition(data={"contains_food": True, "input_quality": "clear", "items": self.items,
                                    "overall_notes": None}, provider=self.name, model=self.model)


def _model_item(name: str, desc: str, quantity: float, unit: str, weight: float | None = None) -> dict:
    return {"food_name": name, "original_description": desc, "brand": None, "quantity": quantity, "unit": unit,
            "quantity_source": "user_stated", "estimated_weight_g": weight, "visible_ingredients": [],
            "preparation": None, "meal_group": None, "confidence": 0.9, "notes": None}


THALI = [_model_item("Chapati", "two rotis", 2, "piece"), _model_item("Dal", "one bowl of dal", 1, "bowl"),
         _model_item("Paneer sabzi", "150g paneer sabzi", 150, "g", 150)]


@pytest.fixture(scope="module")
def scripted() -> _ScriptedProvider:
    return _ScriptedProvider(THALI)


@pytest.fixture(scope="module")
def rec_api(live: dict[str, str], scripted: _ScriptedProvider) -> TestClient:
    settings = Settings(environment=Environment.development, supabase_url=live["url"], supabase_anon_key=live["anon"])
    with TestClient(create_app(settings, recognizer=scripted)) as client:
        yield client


def test_text_to_proposal_to_log_parity(live: dict[str, str], rec_api: TestClient) -> None:
    token, user_id = _sign_up(live)
    r = rec_api.post("/v1/recognitions/text", headers=_h(token),
                     json={"text": "I ate two rotis, one bowl of dal and 150g paneer sabzi"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [c["quantity_source"] for c in body["recognition"]["candidates"]] == ["user_stated"] * 3
    items = body["proposal"]["items"]
    if all(i["match"]["options"] == [] for i in items):
        pytest.skip("catalogue is empty: load INDB first")
    assert body["proposal"]["requires_confirmation"] is True
    # Nothing was logged by recognition.
    logs = httpx.get(f"{live['url']}/rest/v1/food_logs", params={"select": "id"},
                     headers={"apikey": live["anon"], **_h(token)}).json()
    assert logs == []

    # Resolve anything ambiguous the way the review screen would: pick the first option.
    edited = []
    for c, it in zip(body["recognition"]["candidates"], items):
        chosen = (it["match"]["selected"] or (it["match"]["options"] or [None])[0])
        edited.append({"candidate_id": c["candidate_id"], "food_name": c["food_name"],
                       "quantity": c["estimated_quantity"], "unit": c["quantity_unit"],
                       "quantity_source": c["quantity_source"], "recognition_confidence": c["recognition_confidence"],
                       "selected_food_id": chosen["food_id"] if chosen else None})
    proposal = rec_api.post("/v1/proposals/ground", headers=_h(token), json={"items": edited}).json()
    ready = [i for i in proposal["items"] if i["status"] == "ready"]
    assert ready, proposal

    # 150 g paneer sabzi stays exactly 150 g.
    paneer = next(i for i in proposal["items"] if i["food_name"] == "Paneer sabzi")
    assert paneer["portion"]["grams"] == 150 and paneer["portion"]["is_estimate"] is False

    # Confirm: log as the app does; the database's snapshot equals the proposal.
    for it in ready:
        saved = httpx.post(f"{live['url']}/rest/v1/food_logs",
                           headers={"apikey": live["anon"], **_h(token), "Prefer": "return=representation"},
                           json={"user_id": user_id, "logged_date": dt.date.today().isoformat(), "meal_type": "lunch",
                                 "food_name": it["match"]["selected"]["name"], "calories": it["nutrition"]["calories"],
                                 "serving_g": it["portion"]["grams"], "source": "ai_assisted",
                                 "ai_confidence": it["confidence"]["recognition"],
                                 "food_id": it["match"]["selected"]["food_id"]})
        assert saved.status_code == 201, saved.text
        log = saved.json()[0]
        assert float(log["calories"]) == it["nutrition"]["calories"]
        for k in ("protein_g", "carbs_g", "fat_g"):
            assert float(log[k]) == pytest.approx(it["nutrition"][k])


def test_photo_recognition_reads_only_the_owners_image(live: dict[str, str], rec_api: TestClient,
                                                       scripted: _ScriptedProvider) -> None:
    token_a, _ = _sign_up(live)
    token_b, _ = _sign_up(live)
    image = rec_api.post("/v1/meal-images", content=_jpeg_with_gps(),
                         headers={**_h(token_a), "Content-Type": "image/jpeg"}).json()
    before = len(scripted.inputs)
    assert rec_api.post("/v1/recognitions/image", json={"image_id": image["id"]}, headers=_h(token_b)).status_code == 404
    assert len(scripted.inputs) == before, "another user's photo never reaches the model"

    r = rec_api.post("/v1/recognitions/image", json={"image_id": image["id"]}, headers=_h(token_a))
    assert r.status_code == 200, r.text
    sent = scripted.inputs[-1].image_jpeg
    assert sent[:3] == b"\xff\xd8\xff" and b"SpyCam" not in sent, "the model gets the metadata-free copy"
    assert all(c["quantity_source"] == "model_estimate" for c in r.json()["recognition"]["candidates"])
    rec_api.delete(f"/v1/meal-images/{image['id']}", headers=_h(token_a))


@pytest.mark.skipif(os.getenv("GEMINI_LIVE") != "1", reason="set GEMINI_LIVE=1 (and GEMINI_API_KEY) to call the real model; costs money")
def test_real_model_text_recognition() -> None:
    import asyncio

    from app.services.recognition import pipeline
    from app.services.recognition.providers import GeminiProvider

    provider = GeminiProvider(api_key=os.environ["GEMINI_API_KEY"], model=os.getenv("RECOGNITION_MODEL", "gemini-3.8-flash"),
                                 effort="medium", timeout=60)
    result = asyncio.run(pipeline.recognize_text(provider, "I ate two rotis, one bowl of dal and 150g paneer sabzi", 12))
    got = {(c.estimated_quantity, c.quantity_unit, c.quantity_source) for c in result.candidates}
    assert len(result.candidates) == 3
    assert (150, "g", "user_stated") in got and (2, "piece", "user_stated") in got
