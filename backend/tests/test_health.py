from fastapi.testclient import TestClient


def test_health_is_public_and_minimal(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_leaks_no_configuration(client: TestClient) -> None:
    body = client.get("/health").text.lower()
    for secret_ish in ("supabase", "anon", "key", "secret", "jwt", "version", "environment"):
        assert secret_ish not in body


def test_unknown_route_is_plain_404(client: TestClient) -> None:
    response = client.get("/does-not-exist")
    assert response.status_code == 404
    assert "Traceback" not in response.text
