"""Provider-neutral LLM layer: types, errors, providers and the LLM service.

Business logic (the assistant, summaries) depends only on `types`, `errors`
and `service`; vendor SDKs are confined to provider modules (`gemini`).
"""
