"""Meal photo validation and normalisation.

Every upload is decoded and re-encoded server-side before it is stored:
  * Only JPEG, PNG and WebP are accepted, checked by magic bytes AND by what
    the decoder actually finds (a renamed or polyglot file fails).
  * Decompression bombs are refused: a pixel cap, and Pillow's bomb warning
    is treated as an error. The whole image is decoded, so truncated or
    corrupt files fail here.
  * EXIF orientation is applied, then the pixels are copied into a brand-new
    image, so NO metadata survives: no GPS, camera, timestamps, comments or
    ICC/XMP blocks.
  * Transparency is flattened onto white; output is RGB JPEG, longest side
    capped (default 2048 px).
The stored object is always a file this server wrote, never the client's bytes.
"""

from __future__ import annotations

import hashlib
import io
import warnings
from dataclasses import dataclass

from PIL import Image, ImageOps, UnidentifiedImageError

ACCEPTED_CONTENT_TYPES = ("image/jpeg", "image/png", "image/webp")
MAX_PIXELS = 40_000_000           # ~ 7300 x 5500; larger is refused before decoding
MIN_SIDE = 32
JPEG_QUALITY = 85
MAX_OUTPUT_BYTES = 5 * 1024 * 1024  # bucket limit (migration 009)

_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}


class UnsupportedImage(ValueError):
    """Not a JPEG/PNG/WebP. Message is safe to show."""


class InvalidImage(ValueError):
    """Claims to be an image but can't be safely decoded. Message is safe to show."""


@dataclass(frozen=True)
class ProcessedImage:
    data: bytes
    width: int
    height: int
    sha256: str
    content_type: str = "image/jpeg"


def sniff(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def process_image(data: bytes, max_dimension: int = 2048) -> ProcessedImage:
    detected = sniff(data)
    if detected is None:
        raise UnsupportedImage("Only JPEG, PNG or WebP photos are accepted.")

    previous_limit = Image.MAX_IMAGE_PIXELS
    try:
        Image.MAX_IMAGE_PIXELS = MAX_PIXELS
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            try:
                with Image.open(io.BytesIO(data)) as img:
                    if _FORMATS.get(img.format or "") != detected:
                        raise UnsupportedImage("The file's contents don't match an accepted image type.")
                    if img.width * img.height > MAX_PIXELS:
                        raise InvalidImage("The photo is too large.")
                    img.seek(0)          # first frame of animated WebP/PNG
                    img.load()           # full decode: truncated/corrupt data fails here
                    oriented = ImageOps.exif_transpose(img)
                    clean = _flatten_to_rgb(oriented)
            except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
                raise InvalidImage("The photo is too large.") from exc
            except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
                if isinstance(exc, (UnsupportedImage, InvalidImage)):
                    raise
                raise InvalidImage("The photo couldn't be read. It may be damaged.") from exc
    finally:
        Image.MAX_IMAGE_PIXELS = previous_limit

    if min(clean.size) < MIN_SIDE:
        raise InvalidImage("The photo is too small.")
    clean.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)

    quality = JPEG_QUALITY
    while True:
        out = io.BytesIO()
        # A fresh image carries no info dict: nothing but pixels is written.
        clean.save(out, format="JPEG", quality=quality, optimize=True)
        encoded = out.getvalue()
        if len(encoded) <= MAX_OUTPUT_BYTES or quality <= 50:
            break
        quality -= 10
    if len(encoded) > MAX_OUTPUT_BYTES:
        raise InvalidImage("The photo is too large.")

    return ProcessedImage(
        data=encoded, width=clean.width, height=clean.height, sha256=hashlib.sha256(encoded).hexdigest()
    )


def _flatten_to_rgb(img: Image.Image) -> Image.Image:
    """A new RGB image with only the pixels: transparency over white, no metadata."""
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        canvas = Image.new("RGB", rgba.size, (255, 255, 255))
        canvas.paste(rgba, mask=rgba.getchannel("A"))
        return canvas
    rgb = img.convert("RGB")
    canvas = Image.new("RGB", rgb.size)
    canvas.paste(rgb)
    return canvas
