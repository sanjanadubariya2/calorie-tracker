"""Deterministic meal recommendations (Phase 3, Task 3).

config      weights, tolerances and limits (pure data)
models      candidates, user context, results (pure data)
engine      hard filters, portions, scoring, diversity, explanations (pure functions)
repository  loads candidates and user context through PostgREST as the user
service     orchestration: engine -> database pricing -> history

No LLM is involved anywhere in this package. See docs/recommendation-scoring.md.
"""
