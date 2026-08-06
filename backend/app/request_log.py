"""Readable console log for every inbound HTTP request - replaces uvicorn's
default access log (`INFO:     127.0.0.1:54321 - "GET /api/x HTTP/1.1" 200
OK`, one indistinguishable line per hit, client IP included) with a single
line per request: emoji by method, the path, status code and duration -
colored by outcome (dim for 2xx/3xx, yellow for 4xx, red for 5xx or an
unhandled exception) instead of a level word. Time is HH:MM:SS only, no
date, no client IP - this is a local single-user dev tool.

Reuses `console_log`'s encoding-safe printing so multi-byte emoji survive the
same `npm run dev` (`concurrently`) pipe that outbound AI-provider-call
logging already has to survive (see `console_log._safe_print`).
"""

from __future__ import annotations

import time
from datetime import datetime

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from .console_log import _RED, _RESET, _YELLOW, _safe_print

_DIM = '\033[90m'

_METHOD_EMOJI = {
    'GET': '📥',
    'POST': '📮',
    'PUT': '✏️',
    'PATCH': '✏️',
    'DELETE': '🗑️',
}


def _color_for_status(status_code: int) -> str:
    if status_code >= 500:
        return _RED
    if status_code >= 400:
        return _YELLOW
    return _DIM


def _format(method: str, path: str, status_code: int, duration_ms: float) -> str:
    time_str = datetime.now().strftime('%H:%M:%S')
    emoji = _METHOD_EMOJI.get(method, '🌐')
    color = _color_for_status(status_code)
    return f'{color}{time_str} {emoji} {method} {path} -> {status_code} ({duration_ms:.0f}ms){_RESET}'


class RequestLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        start = time.monotonic()
        try:
            response = await call_next(request)
        except Exception:
            duration_ms = (time.monotonic() - start) * 1000
            _safe_print(_format(request.method, request.url.path, 500, duration_ms))
            raise

        duration_ms = (time.monotonic() - start) * 1000
        _safe_print(_format(request.method, request.url.path, response.status_code, duration_ms))
        return response
