"""Meal image processing and /v1/meal-images."""

from __future__ import annotations

import io
import json
import re
import uuid
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.services import meal_images as mi
from tests.conftest import ANON_KEY, FakeSupabase

# ------------------------------------------------------------------ fixtures


def jpeg_with_exif(width: int = 400, height: int = 300, orientation: int | None = None) -> bytes:
    img = Image.new("RGB", (width, height), (200, 120, 40))
    exif = Image.Exif()
    exif[0x010F] = "SpyCam"                       # Make
    exif[0x0132] = "2026:11:20 08:00:00"          # DateTime
    gps = {1: "N", 2: (28.0, 36.0, 50.0), 3: "E", 4: (77.0, 12.0, 30.0)}
    exif[0x8825] = gps                            # GPSInfo
    if orientation:
        exif[0x0112] = orientation
    out = io.BytesIO()
    img.save(out, "JPEG", exif=exif.tobytes(), comment=b"secret comment")
    return out.getvalue()


def png_rgba(width: int = 120, height: int = 80) -> bytes:
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    out = io.BytesIO()
    img.save(out, "PNG")
    return out.getvalue()


def webp(width: int = 100, height: int = 100) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), (10, 200, 10)).save(out, "WEBP")
    return out.getvalue()


# ------------------------------------------------------------------ processing

def test_metadata_and_gps_are_stripped() -> None:
    result = mi.process_image(jpeg_with_exif())
    out = Image.open(io.BytesIO(result.data))
    assert out.format == "JPEG" and out.mode == "RGB"
    assert dict(out.getexif()) == {}
    assert "exif" not in out.info and "comment" not in out.info and "icc_profile" not in out.info
    assert b"SpyCam" not in result.data and b"secret comment" not in result.data


def test_orientation_is_applied_before_stripping() -> None:
    # Orientation 6 = rotate 90° clockwise to display: 400x300 becomes 300x400.
    result = mi.process_image(jpeg_with_exif(400, 300, orientation=6))
    assert (result.width, result.height) == (300, 400)


def test_large_images_are_downscaled() -> None:
    img = Image.new("RGB", (5000, 2500), (1, 2, 3))
    out = io.BytesIO()
    img.save(out, "JPEG")
    result = mi.process_image(out.getvalue(), max_dimension=2048)
    assert (result.width, result.height) == (2048, 1024)


def test_png_transparency_is_flattened_onto_white() -> None:
    result = mi.process_image(png_rgba())
    pixel = Image.open(io.BytesIO(result.data)).getpixel((5, 5))
    assert all(channel > 245 for channel in pixel)


def test_webp_is_accepted_and_reencoded_as_jpeg() -> None:
    result = mi.process_image(webp())
    assert result.content_type == "image/jpeg" and result.data[:3] == b"\xff\xd8\xff"


def test_sha256_is_of_the_stored_bytes() -> None:
    import hashlib

    result = mi.process_image(webp())
    assert result.sha256 == hashlib.sha256(result.data).hexdigest()


@pytest.mark.parametrize("data", [
    b"GIF89a" + b"\x00" * 100,
    b"<html><script>alert(1)</script></html>",
    b"%PDF-1.7 ...",
    b"\x00\x00\x00\x18ftypheic" + b"\x00" * 50,   # HEIC
    b"",
])
def test_unsupported_types_are_refused(data: bytes) -> None:
    with pytest.raises(mi.UnsupportedImage):
        mi.process_image(data)


def test_mismatched_content_is_refused() -> None:
    # JPEG magic bytes followed by PNG data: the decoder disagrees with the claimed type.
    with pytest.raises((mi.UnsupportedImage, mi.InvalidImage)):
        mi.process_image(b"\xff\xd8\xff" + png_rgba())


def test_truncated_image_is_refused() -> None:
    data = jpeg_with_exif()
    with pytest.raises(mi.InvalidImage):
        mi.process_image(data[: len(data) // 3])


def test_decompression_bomb_is_refused() -> None:
    # A tiny PNG that claims 20000 x 20000 pixels (400 MP): refused before decoding.
    img = Image.new("1", (20000, 20000))
    out = io.BytesIO()
    img.save(out, "PNG")
    assert len(out.getvalue()) < 200_000
    with pytest.raises(mi.InvalidImage, match="too large"):
        mi.process_image(out.getvalue())


def test_tiny_images_are_refused() -> None:
    out = io.BytesIO()
    Image.new("RGB", (8, 8)).save(out, "JPEG")
    with pytest.raises(mi.InvalidImage, match="too small"):
        mi.process_image(out.getvalue())


# ------------------------------------------------------------------ endpoint

class FakeBackends:
    """meal_images rows (as PostgREST would apply them) + storage objects."""

    def __init__(self) -> None:
        self.rows: dict[str, dict[str, Any]] = {}
        self.objects: dict[str, bytes] = {}
        self.fail_upload = False
        self.rate_limited = False

    def rest(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/rest/v1/meal_images"
        image_id = (request.url.params.get("id") or "").removeprefix("eq.")
        if request.method == "POST":
            if self.rate_limited:
                return httpx.Response(400, json={"code": "54000", "message": "Too many"})
            row = json.loads(request.content)
            row.update(status="uploaded", created_at="2026-11-20T10:00:00Z", expires_at="2026-12-20T10:00:00Z")
            self.rows[row["id"]] = row
            return httpx.Response(201, json=[row])
        if request.method == "GET":
            return httpx.Response(200, json=[self.rows[image_id]] if image_id in self.rows else [])
        if request.method == "DELETE":
            row = self.rows.pop(image_id, None)
            return httpx.Response(200, json=[row] if row else [])
        return httpx.Response(405)

    def storage(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "POST" and path.startswith("/storage/v1/object/sign/"):
            key = path.removeprefix("/storage/v1/object/sign/meal-images/")
            return httpx.Response(200, json={"signedURL": f"/object/sign/meal-images/{key}?token=t"})
        if request.method == "POST" and path.startswith("/storage/v1/object/meal-images/"):
            if self.fail_upload:
                return httpx.Response(500, json={"statusCode": "500", "error": "boom"})
            self.objects[path.removeprefix("/storage/v1/object/meal-images/")] = request.content
            return httpx.Response(200, json={"Key": path})
        if request.method == "DELETE":
            self.objects.pop(path.removeprefix("/storage/v1/object/meal-images/"), None)
            return httpx.Response(200, json={})
        return httpx.Response(404)


@pytest.fixture
def backends(fake_supabase: FakeSupabase) -> FakeBackends:
    b = FakeBackends()
    fake_supabase.rest_handler = b.rest
    fake_supabase.storage_handler = b.storage
    return b


def _post(client: TestClient, token: str, data: bytes, content_type: str = "image/jpeg") -> httpx.Response:
    return client.post("/v1/meal-images", content=data,
                       headers={"Authorization": f"Bearer {token}", "Content-Type": content_type})


def test_upload_stores_a_clean_jpeg_in_the_users_folder(client: TestClient, make_token: Callable[..., str],
                                                       fake_supabase: FakeSupabase, backends: FakeBackends) -> None:
    user_id = str(uuid.uuid4())
    token = make_token(user_id)
    response = _post(client, token, jpeg_with_exif())
    assert response.status_code == 201, response.text
    body = response.json()
    image_id = body["id"]
    path = f"{user_id}/{image_id}.jpg"
    assert re.fullmatch(r"[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg", path)
    assert backends.rows[image_id]["storage_path"] == path
    stored = backends.objects[path]
    assert b"SpyCam" not in stored and dict(Image.open(io.BytesIO(stored)).getexif()) == {}
    assert body["url"].startswith("https://project-ref.supabase.co/storage/v1/object/sign/meal-images/")
    assert (body["width"], body["height"], body["size_bytes"]) == (400, 300, len(stored))

    upload = next(r for r in fake_supabase.storage_requests if r.method == "POST" and "/sign/" not in r.url.path)
    assert upload.headers["authorization"] == f"Bearer {token}"   # as the user: storage policies apply
    assert upload.headers["apikey"] == ANON_KEY
    assert upload.headers["x-upsert"] == "false"
    assert upload.headers["content-type"] == "image/jpeg"


def test_row_is_created_before_upload_and_removed_if_upload_fails(client: TestClient, make_token: Callable[..., str],
                                                                  backends: FakeBackends) -> None:
    backends.fail_upload = True
    response = _post(client, make_token(), jpeg_with_exif())
    assert response.status_code == 502
    assert backends.rows == {} and backends.objects == {}


def test_rate_limit_is_429_and_nothing_is_uploaded(client: TestClient, make_token: Callable[..., str],
                                                   backends: FakeBackends) -> None:
    backends.rate_limited = True
    response = _post(client, make_token(), jpeg_with_exif())
    assert response.status_code == 429 and backends.objects == {}


@pytest.mark.parametrize("content_type", ["image/gif", "text/html", "application/octet-stream", ""])
def test_wrong_content_type_is_415(client: TestClient, make_token: Callable[..., str], backends: FakeBackends,
                                   content_type: str) -> None:
    assert _post(client, make_token(), jpeg_with_exif(), content_type).status_code == 415


def test_body_contents_are_checked_not_just_the_header(client: TestClient, make_token: Callable[..., str],
                                                       backends: FakeBackends) -> None:
    response = _post(client, make_token(), b"<html>not an image</html>", "image/jpeg")
    assert response.status_code == 415 and backends.rows == {}


def test_oversized_upload_is_413(settings, fake_supabase: FakeSupabase, make_token: Callable[..., str],
                                 backends: FakeBackends) -> None:
    from app.main import create_app

    small = settings.model_copy(update={"meal_image_max_upload_bytes": 2048})
    with TestClient(create_app(small, transport=httpx.MockTransport(fake_supabase.handle))) as c:
        assert _post(c, make_token(), jpeg_with_exif()).status_code == 413
    assert backends.rows == {}


def test_corrupt_image_is_422(client: TestClient, make_token: Callable[..., str], backends: FakeBackends) -> None:
    data = jpeg_with_exif()
    assert _post(client, make_token(), data[: len(data) // 3]).status_code == 422


def test_upload_requires_auth(client: TestClient, backends: FakeBackends) -> None:
    response = client.post("/v1/meal-images", content=jpeg_with_exif(), headers={"Content-Type": "image/jpeg"})
    assert response.status_code == 401 and backends.rows == {}


def test_get_and_delete(client: TestClient, make_token: Callable[..., str], backends: FakeBackends) -> None:
    user_id = str(uuid.uuid4())
    token = make_token(user_id)
    image_id = _post(client, token, webp()).json()["id"]
    got = client.get(f"/v1/meal-images/{image_id}", headers={"Authorization": f"Bearer {token}"})
    assert got.status_code == 200 and "token=" in got.json()["url"]

    deleted = client.delete(f"/v1/meal-images/{image_id}", headers={"Authorization": f"Bearer {token}"})
    assert deleted.status_code == 204
    assert backends.rows == {} and backends.objects == {}
    assert client.get(f"/v1/meal-images/{image_id}", headers={"Authorization": f"Bearer {token}"}).status_code == 404


def test_unknown_or_foreign_image_is_404(client: TestClient, make_token: Callable[..., str], backends: FakeBackends) -> None:
    # RLS returns no row for another user's image, so it is indistinguishable from "missing".
    response = client.get(f"/v1/meal-images/{uuid.uuid4()}", headers={"Authorization": f"Bearer {make_token()}"})
    assert response.status_code == 404
    assert client.get("/v1/meal-images/not-a-uuid", headers={"Authorization": f"Bearer {make_token()}"}).status_code == 422
