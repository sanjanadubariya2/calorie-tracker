"""Phase 2 Task 5: food-log proposals and the confirmation-only path."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.llm.service import LLMService, RetryPolicy
from app.main import create_app
from tests.assistant_fakes import (
    FakeNutritionDB,
    InMemoryProposals,
    InMemoryStore,
    ScriptedLLM,
    call,
    food,
    reply,
    respond,
    search_row,
    status_row,
)
from tests.conftest import FakeSupabase

A = "aaaaaaaa-0000-0000-0000-00000000000a"
B = "bbbbbbbb-0000-0000-0000-00000000000b"

EGG = food("Boiled egg", "egg_dish", 155, 12.6, 50, carbs100=1.1, fat100=10.6, label="1 piece")
DAL_MOONG = food("Moong dal", "dal", 110, 7, 180, label="1 bowl")
DAL_MIXED = food("Mixed dal", "dal", 120, 7.5, 180, label="1 bowl")


class H:
    def __init__(self, c: TestClient, llm: ScriptedLLM, db: FakeNutritionDB, props: InMemoryProposals,
                 make_token: Callable[..., str]) -> None:
        self.c, self.llm, self.db, self.props = c, llm, db, props
        self.tok = {A: make_token(A), B: make_token(B)}
        self.cid = self.c.post("/v1/assistant/conversations", json={}, headers=self.h()).json()["id"]

    def h(self, uid: str = A) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.tok[uid]}"}

    def send(self, text: str) -> dict[str, Any]:
        r = self.c.post(f"/v1/assistant/conversations/{self.cid}/messages", headers=self.h(),
                        json={"content": text, "client_message_id": str(uuid.uuid4()), "local_date": "2026-11-20"})
        assert r.status_code == 200, r.text
        return r.json()

    def confirm(self, pid: str, uid: str = A, **body: Any) -> httpx.Response:
        return self.c.post(f"/v1/assistant/proposals/{pid}/confirm", headers=self.h(uid), json=body)

    def logs(self, uid: str = A) -> list[dict[str, Any]]:
        return self.db.user(uid).logs

    def propose_eggs(self, text: str = "Log two boiled eggs for breakfast") -> dict[str, Any]:
        self.llm.then(
            reply(call("prepare_food_log", items=[{"food_name": "boiled egg", "quantity": 2, "unit": "piece"}],
                       meal_type="breakfast")),
            reply(respond("proposed_action", "Here's 2 boiled eggs for breakfast. Review and tap Confirm.")))
        return self.send(text)["assistant_message"]["response"]


@pytest.fixture
def h(settings: Settings, fake_supabase: FakeSupabase, make_token: Callable[..., str]) -> Iterator[H]:
    db = FakeNutritionDB()
    db.user(A).status = status_row()
    db.foods = [EGG, DAL_MOONG, DAL_MIXED]
    db.search_by_query = {
        "boiled egg": [search_row(EGG, 0.97, "exact")],
        "dal": [search_row(DAL_MOONG, 0.78), search_row(DAL_MIXED, 0.76)],
        "unicorn steak": [],
    }
    fake_supabase.rpc_handler = db.handle_rpc
    fake_supabase.rest_handler = db.handle_rest
    llm = ScriptedLLM()
    props = InMemoryProposals()
    app = create_app(settings, transport=httpx.MockTransport(fake_supabase.handle),
                     llm=LLMService(llm, retry=RetryPolicy(attempts=1)), assistant_store=InMemoryStore(),
                     proposal_store=props)
    with TestClient(app, raise_server_exceptions=False) as c:
        yield H(c, llm, db, props, make_token)


# ============================================================================ proposals

def test_valid_food_log_proposal(h: H) -> None:
    resp = h.propose_eggs()
    assert resp["type"] == "proposed_action"
    p = resp["action"]["proposal"]
    assert p["status"] == "pending" and p["requires_user_confirmation"] is True and p["meal_type"] == "breakfast"
    item = p["items"][0]
    assert item["food_id"] == EGG["id"] and item["food_name"] == "Boiled egg"
    assert (item["quantity"], item["unit"], item["grams"]) == (2, "piece", 100)
    assert item["quantity_source"] == "user_stated"        # "two" is in the user's text
    assert item["nutrition"] == {"calories": 155.0, "protein_g": 12.6, "carbs_g": 1.1, "fat_g": 10.6}
    assert item["nutrition_source"] == "indb" and item["source_ref"] == EGG["source_ref"]
    assert p["totals"]["calories"] == 155.0
    assert dt.datetime.fromisoformat(p["expires_at"]) > dt.datetime.now(dt.timezone.utc)
    assert h.logs() == []                                   # nothing logged by the assistant


def test_ambiguous_food_asks_with_options(h: H) -> None:
    h.llm.then(reply(call("prepare_food_log", items=[{"food_name": "dal", "quantity": 1, "unit": "bowl"}], meal_type="lunch")),
               reply(respond("clarification", "Which dal was it?", clarification_options=["Moong dal", "Mixed dal"])))
    resp = h.send("log a bowl of dal for lunch")["assistant_message"]["response"]
    assert resp["type"] == "clarification" and resp["options"] == ["Moong dal", "Mixed dal"]
    issue = resp["food_issues"][0]
    assert issue["issue"] == "ambiguous_food" and [o["name"] for o in issue["options"]] == ["Moong dal", "Mixed dal"]
    assert h.props.rows == {}                               # no proposal created


def test_choice_from_options_creates_the_proposal(h: H) -> None:
    h.llm.then(
        reply(call("search_foods", query="dal")),
        reply(call("prepare_food_log", items=[{"food_name": "dal", "food_id": DAL_MIXED["id"], "quantity": 1,
                                               "unit": "bowl"}], meal_type="lunch")),
        reply(respond("proposed_action", "Mixed dal, 1 bowl. Tap Confirm to log it.")))
    p = h.send("the mixed dal, one bowl")["assistant_message"]["response"]["action"]["proposal"]
    assert p["items"][0]["food_name"] == "Mixed dal" and p["items"][0]["grams"] == 180


def test_unseen_food_ids_are_refused(h: H) -> None:
    h.llm.then(reply(call("prepare_food_log", items=[{"food_name": "dal", "food_id": DAL_MIXED["id"], "quantity": 1,
                                                      "unit": "bowl"}], meal_type="lunch")),
               reply(respond("text", "Let me search first.")))
    h.send("log mixed dal")
    err = h.llm.requests[1].messages[-1].tool_results[0].content["error"]
    assert "search_foods" in err["message"] and h.props.rows == {}


def test_missing_quantity_is_asked_not_assumed(h: H) -> None:
    h.llm.then(reply(call("prepare_food_log", items=[{"food_name": "boiled egg"}], meal_type="breakfast")),
               reply(respond("clarification", "How many boiled eggs?")))
    resp = h.send("log boiled eggs for breakfast")["assistant_message"]["response"]
    issue = resp["food_issues"][0]
    assert issue["issue"] == "quantity_missing" and "1 piece (50 g)" in issue["question"]
    assert h.props.rows == {}


def test_unknown_food(h: H) -> None:
    h.llm.then(reply(call("prepare_food_log", items=[{"food_name": "unicorn steak", "quantity": 1, "unit": "piece"}],
                          meal_type="dinner")),
               reply(respond("clarification", "I couldn't find that. What was in it?")))
    issue = h.send("log a unicorn steak")["assistant_message"]["response"]["food_issues"][0]
    assert issue["issue"] == "unknown_food"


@pytest.mark.parametrize("item", [
    {"food_name": "boiled egg", "quantity": 0, "unit": "piece"},
    {"food_name": "boiled egg", "quantity": -2, "unit": "piece"},
    {"food_name": "boiled egg", "quantity": 2, "unit": "handful"},
    {"food_name": "boiled egg", "quantity": 20000, "unit": "g"},
])
def test_invalid_quantity_is_rejected(h: H, item: dict[str, Any]) -> None:
    h.llm.then(reply(call("prepare_food_log", items=[item], meal_type="breakfast")),
               reply(respond("clarification", "How much was it?")))
    h.send("log eggs")
    assert h.llm.requests[1].messages[-1].tool_results[0].content["error"]["code"] == "invalid_arguments"
    assert h.props.rows == {}


def test_unconvertible_portion_asks(h: H) -> None:
    h.llm.then(reply(call("prepare_food_log", items=[{"food_name": "boiled egg", "quantity": 2, "unit": "ml"}],
                          meal_type="breakfast")),
               reply(respond("clarification", "How many eggs is that?")))
    issue = h.send("log 2 ml of egg")["assistant_message"]["response"]["food_issues"][0]
    assert issue["issue"] == "portion_unresolved"


def test_model_cannot_claim_a_proposal_without_one(h: H) -> None:
    h.llm.then(reply(respond("proposed_action", "Proposal ready!")), reply(respond("text", "Which meal was it?")))
    assert h.send("log eggs")["assistant_message"]["response"]["type"] == "text"


def test_saying_yes_in_chat_does_not_confirm(h: H) -> None:
    pid = h.propose_eggs()["action"]["proposal"]["id"]
    h.llm.then(reply(respond("text", "Please tap Confirm on the proposal to log it.")))
    h.send("yes")
    assert h.logs() == [] and h.props.rows[pid]["status"] == "pending"
    # And no tool exists that could confirm it.
    tools = {t.name for t in h.llm.requests[-1].tools}
    assert not [t for t in tools if "confirm" in t or "save" in t or "log_food" == t]


# ============================================================================ confirmation

def test_explicit_confirmation_logs_through_the_normal_path(h: H) -> None:
    pid = h.propose_eggs()["action"]["proposal"]["id"]
    r = h.confirm(pid)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["proposal"]["status"] == "confirmed" and len(body["food_logs"]) == 1
    [log] = h.logs()
    assert log["food_id"] == EGG["id"] and log["serving_g"] == 100 and log["source"] == "ai_assisted"
    assert log["meal_type"] == "breakfast" and log["logged_date"] == "2026-11-20"
    assert log["nutrients_per_100g"]["kcal"] == 155       # provenance snapshot (the database re-derives it from food_id)
    assert h.props.rows[pid]["food_log_ids"] == [body["food_logs"][0]["id"]]


def test_confirmation_with_edits_is_repriced(h: H) -> None:
    pid = h.propose_eggs()["action"]["proposal"]["id"]
    r = h.confirm(pid, meal_type="morning_snack", items=[{"index": 0, "quantity": 3}])
    assert r.status_code == 200, r.text
    [log] = h.logs()
    assert log["serving_g"] == 150 and log["meal_type"] == "morning_snack"
    assert log["calories"] == 232                       # 155 kcal/100 g x 150 g, recomputed by the backend


def test_edit_removing_everything_is_refused(h: H) -> None:
    pid = h.propose_eggs()["action"]["proposal"]["id"]
    r = h.confirm(pid, items=[{"index": 0, "remove": True}])
    assert r.status_code == 422 and h.logs() == []
    assert h.props.rows[pid]["status"] == "pending"     # still confirmable


@pytest.mark.parametrize("body", [{"items": [{"index": 5}]}, {"items": [{"index": 0, "quantity": -1}]},
                                  {"items": [{"index": 0, "calories": 10}]}, {"user_id": B}, {"meal_type": "brunch"}])
def test_confirmation_body_is_validated(h: H, body: dict[str, Any]) -> None:
    pid = h.propose_eggs()["action"]["proposal"]["id"]
    assert h.confirm(pid, **body).status_code == 422 and h.logs() == []


def test_duplicate_confirmation(h: H) -> None:
    pid = h.propose_eggs()["action"]["proposal"]["id"]
    assert h.confirm(pid).status_code == 200
    again = h.confirm(pid)
    assert again.status_code == 409 and "already logged" in again.json()["detail"]
    assert len(h.logs()) == 1


def test_rejected_proposal(h: H) -> None:
    pid = h.propose_eggs()["action"]["proposal"]["id"]
    r = h.c.post(f"/v1/assistant/proposals/{pid}/reject", headers=h.h())
    assert r.status_code == 200 and r.json()["status"] == "rejected"
    assert h.confirm(pid).status_code == 409 and h.logs() == []
    assert h.c.post(f"/v1/assistant/proposals/{pid}/reject", headers=h.h()).status_code == 409


def test_expired_proposal(h: H) -> None:
    pid = h.propose_eggs()["action"]["proposal"]["id"]
    h.props.rows[pid]["expires_at"] = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)
    assert h.c.get(f"/v1/assistant/proposals/{pid}", headers=h.h()).json()["status"] == "expired"
    r = h.confirm(pid)
    assert r.status_code == 410 and h.logs() == []
    assert h.props.rows[pid]["status"] == "expired"


def test_cross_user_proposal_access(h: H) -> None:
    pid = h.propose_eggs()["action"]["proposal"]["id"]
    assert h.c.get(f"/v1/assistant/proposals/{pid}", headers=h.h(B)).status_code == 404
    assert h.confirm(pid, uid=B).status_code == 404
    assert h.c.post(f"/v1/assistant/proposals/{pid}/reject", headers=h.h(B)).status_code == 404
    assert h.logs(A) == [] and h.logs(B) == [] and h.props.rows[pid]["status"] == "pending"
    assert h.c.post(f"/v1/assistant/proposals/{uuid.uuid4()}/confirm", headers=h.h(), json={}).status_code == 404


def test_database_failure_during_saving(h: H) -> None:
    pid = h.propose_eggs()["action"]["proposal"]["id"]
    h.db.fail_food_log_insert = True
    r = h.confirm(pid)
    assert r.status_code == 502 and "Nothing was saved" in r.json()["detail"]
    assert h.logs() == [] and h.props.rows[pid]["status"] == "pending"
    h.db.fail_food_log_insert = False
    assert h.confirm(pid).status_code == 200 and len(h.logs()) == 1   # retry works, once


def test_food_removed_from_catalogue_before_confirming(h: H) -> None:
    pid = h.propose_eggs()["action"]["proposal"]["id"]
    h.db.foods = [f for f in h.db.foods if f["id"] != EGG["id"]]
    r = h.confirm(pid)
    assert r.status_code == 422 and h.logs() == [] and h.props.rows[pid]["status"] == "pending"


def test_history_shows_the_current_proposal_status(h: H) -> None:
    pid = h.propose_eggs()["action"]["proposal"]["id"]
    h.confirm(pid)
    msgs = h.c.get(f"/v1/assistant/conversations/{h.cid}/messages", headers=h.h()).json()["items"]
    card = msgs[-1]["response"]["action"]["proposal"]
    assert card["status"] == "confirmed" and len(card["food_log_ids"]) == 1


def test_proposal_requires_auth(h: H) -> None:
    pid = h.propose_eggs()["action"]["proposal"]["id"]
    assert h.c.post(f"/v1/assistant/proposals/{pid}/confirm", json={}).status_code == 401


def test_unreliable_catalogue_values_are_flagged_on_the_proposal(h: H) -> None:
    samosa = {**food("Potato samosa", "snack", 577, 1.7, 141, carbs100=9.2, fat100=59.2, label="1 samosa"),
              "quality_flags": ["cooking_oil_uncertain"]}
    h.db.foods.append(samosa)
    h.db.search_by_query["samosa"] = [{**search_row(samosa, 0.97, "exact"), "quality_flags": ["cooking_oil_uncertain"]}]
    h.llm.then(reply(call("prepare_food_log", items=[{"food_name": "samosa", "quantity": 1, "unit": "piece"}],
                          meal_type="evening_snack")),
               reply(respond("proposed_action", "1 samosa. Note the database value may be high. Tap Confirm to log it.")))
    item = h.send("log a samosa")["assistant_message"]["response"]["action"]["proposal"]["items"][0]
    assert "cooking_oil_uncertain" in item["warnings"]
