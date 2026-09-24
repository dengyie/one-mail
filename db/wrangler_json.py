"""Tolerant JSON extraction for Wrangler CLI output.

`wrangler d1 execute --json` occasionally prints banner/progress lines to
stdout around the JSON payload (version- and pnpm-dependent), which makes a
strict ``json.loads`` of the captured output fail with
``JSONDecodeError: Extra data`` on CI. Deployment must be deterministic, so
we parse the *first complete JSON document* and ignore any surrounding noise.
"""

from __future__ import annotations

import json
from typing import Any


def load_first_json_document(text: str) -> Any:
    """Return the first complete JSON value found in *text*.

    Leading banner/prose lines are skipped; trailing data after the JSON
    document is ignored (raw_decode never consumes past the first value).
    """
    stripped = text.strip()
    decoder = json.JSONDecoder()
    start = 0
    last_error: json.JSONDecodeError | None = None
    while start < len(stripped):
        while start < len(stripped) and stripped[start] not in "{[":
            start += 1
        if start >= len(stripped):
            break
        try:
            value, _ = decoder.raw_decode(stripped[start:])
            return value
        except json.JSONDecodeError as exc:  # candidate was prose containing { or [
            last_error = exc
            start += 1
    if last_error is not None:
        raise ValueError(f"wrangler output contains no parseable JSON document: {last_error}")
    raise ValueError("wrangler output contains no JSON document")
