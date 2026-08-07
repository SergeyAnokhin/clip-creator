"""Shared submit -> poll -> fetch skeleton for FAL's queue-based API
(https://queue.fal.run/{model_id}), used by every FAL call site across
`images.py` and `title_card.py` (text-to-image, reference-image edit,
background removal, outpaint - 4 call sites as of 2026-08, all confirmed
against fal.ai's model API reference independently). Extracted after the 4th
near-identical copy (outpaint) landed, to stop the shape from drifting
between callers (e.g. one copy going out of sync on the `202 IN_PROGRESS`
poll quirk or the final-fetch error-debug branch - see `submit_poll_fetch`'s
own docstring).

Deliberately does **not** own `model_id` -> request-body construction, result
extraction (`images[]` vs a single `image`), NSFW checks, or downloading the
result bytes - those differ per call site and stay there; this module only
owns the three HTTP legs + poll-loop + timeout/failure bookkeeping that are
byte-for-byte identical everywhere.
"""

import asyncio
import time

import httpx


async def submit_poll_fetch(
    fal_base: str, model_id: str, body: dict, api_key: str, debug_request: dict, *,
    usage_out: dict | None = None, poll_interval: float, job_timeout: float,
) -> dict:
    """`POST {fal_base}/{model_id}` -> `{status_url, response_url, status}`;
    poll `status_url` until `status == 'COMPLETED'` (FAL's status endpoint
    can reply `202 Accepted`, not `200`, while a job is still
    IN_QUEUE/IN_PROGRESS - confirmed from a real log line, so only HTTP
    `>=400` is treated as a transport error, the JSON `status` field is what
    actually drives the loop); `GET response_url` for the final JSON payload,
    returned as-is (fal.ai model API reference, 2026-08).

    Sets `usage_out['debug']` on every *transport-failure* exit (bad status
    code on any of the 3 requests, a `FAILED` job status) - not on success,
    since redacting the payload for the debug panel differs per call site's
    response shape (see e.g. `images.py`'s `_generate_fal` vs.
    `title_card.py`'s `_generate_background_remover_fal`); the caller builds
    and sets `usage_out['debug']` itself once it has the payload. Not set on
    a timeout either (`job_timeout` elapsed) - matches every existing call
    site, which never had enough context left to describe what happened.
    `debug_request` is the caller's own already-redacted request summary
    (reference-image bytes / inline image data already replaced with a short
    placeholder - never put raw image bytes in a debug dict, they end up in
    the usage ledger and the frontend's debug panel)."""
    headers = {'Authorization': f'Key {api_key}', 'Content-Type': 'application/json'}

    async with httpx.AsyncClient(timeout=30) as http_client:
        resp = await http_client.post(f'{fal_base}/{model_id}', headers=headers, json=body)
    if resp.status_code >= 400:
        if usage_out is not None:
            usage_out['debug'] = {'request': debug_request, 'response': {'status': resp.status_code, 'text': resp.text[:500]}}
        raise RuntimeError(f'FAL API вернул {resp.status_code}: {resp.text[:300]}')
    submitted = resp.json()
    status_url = submitted['status_url']
    response_url = submitted['response_url']

    deadline = time.monotonic() + job_timeout
    status = submitted.get('status')
    while status != 'COMPLETED':
        if status == 'FAILED':
            if usage_out is not None:
                usage_out['debug'] = {'request': debug_request, 'response': {'status': 'FAILED'}}
            raise RuntimeError('FAL: задание завершилось с ошибкой')
        if time.monotonic() > deadline:
            raise RuntimeError('FAL: превышено время ожидания генерации')
        await asyncio.sleep(poll_interval)
        async with httpx.AsyncClient(timeout=30) as http_client:
            poll = await http_client.get(status_url, headers=headers)
        if poll.status_code >= 400:
            if usage_out is not None:
                usage_out['debug'] = {'request': debug_request, 'response': {'status': poll.status_code, 'text': poll.text[:500]}}
            raise RuntimeError(f'FAL API (poll) вернул {poll.status_code}: {poll.text[:300]}')
        status = poll.json().get('status')

    async with httpx.AsyncClient(timeout=30) as http_client:
        result = await http_client.get(response_url, headers=headers)
    if result.status_code >= 400:
        if usage_out is not None:
            usage_out['debug'] = {'request': debug_request, 'response': {'status': result.status_code, 'text': result.text[:500]}}
        raise RuntimeError(f'FAL API (результат) вернул {result.status_code}: {result.text[:300]}')
    return result.json()
