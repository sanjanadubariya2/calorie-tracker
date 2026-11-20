"""The assistant's tool registry: the complete list of what the model can do."""

from __future__ import annotations

from app.assistant.tools.base import ToolRegistry
from app.assistant.tools.catalogue import SEARCH_FOODS
from app.assistant.tools.nutrition import GET_DAILY_STATUS, GET_NUTRITION_HISTORY, GET_RECENT_FOOD_LOGS, GET_USER_TARGETS
from app.assistant.tools.proposals import PREPARE_FOOD_LOG
from app.assistant.tools.recommend import RECOMMEND_MEALS


def tools_markdown() -> str:
    """Reference for every tool: description, input schema (exactly what the
    model is given) and output schema. `python -m app.cli assistant-tools-doc`."""
    import json

    from app.assistant.responses import RespondArgs

    reg = default_registry()
    out = ["# Assistant tools", "",
           "Generated from the registry (`python -m app.cli assistant-tools-doc`). All tools are read-only, run as "
           "the signed-in user (RLS applies) and can't take a user id. Inputs are validated before running; "
           "outputs are capped at `ASSISTANT_MAX_TOOL_RESULT_CHARS`.", ""]
    for name in reg.names:
        tool = reg.get(name)
        assert tool is not None
        out += [f"## `{name}`", "", tool.description, "",
                f"Backs response types: {', '.join(tool.supports) or 'none (context only)'}", "",
                "Input (sent to the model as the function's JSON Schema):", "", "```json",
                json.dumps(tool.spec().parameters, indent=2), "```", "",
                "Output (`result`):", "", "```json", json.dumps(tool.result.model_json_schema(), indent=2), "```", ""]
    out += ["## `respond` (final answer)", "",
            "Every turn ends with exactly one `respond` call. The server validates it and builds the response; "
            "data cards come from this turn's tool results.", "", "```json",
            json.dumps(RespondArgs.model_json_schema(), indent=2), "```", ""]
    return "\n".join(out)


def default_registry() -> ToolRegistry:
    """Read-only tools plus one proposal tool. There is deliberately no tool that
    writes user records: confirming a proposal is an HTTP-only path the app calls
    after an explicit user action (POST /v1/assistant/proposals/{id}/confirm)."""
    return ToolRegistry([
        # read
        GET_DAILY_STATUS,
        GET_RECENT_FOOD_LOGS,
        SEARCH_FOODS,
        GET_USER_TARGETS,
        GET_NUTRITION_HISTORY,
        RECOMMEND_MEALS,
        # proposal
        PREPARE_FOOD_LOG,
    ])
