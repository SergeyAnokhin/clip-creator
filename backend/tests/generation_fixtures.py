"""Fakes and helpers shared by the `test_generation_*.py` files - the HTTP
client stand-ins every provider patch uses, the job pollers, and the tiny
PNG/upload builders.

The routes under test live in `app/routers/generation_{music,scenes,
title_card,export}.py`, but every patch target is a *provider* module (or
`storage`) - the same module object those routers hold, so patching an
attribute in a test is seen by whichever router imported it."""

import io
import time

from PIL import Image



class _FakeImagesResponse:
    def __init__(self, status_code, payload=None, text=''):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        return self._payload


class _FakeImagesAsyncClient:
    def __init__(self, responses):
        self._responses = list(responses)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, headers=None, json=None, params=None):
        return self._responses.pop(0)

    async def get(self, url, headers=None, params=None):
        return self._responses.pop(0)


def _poll_until_done(client, pid, scene_index, job_id, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = client.get(f'/api/projects/{pid}/scenes/{scene_index}/images/jobs/{job_id}').json()
        if job['status'] != 'pending':
            return job
        time.sleep(0.05)
    raise AssertionError('Job did not complete in time')


def _tiny_png(width=10, height=10):
    out = io.BytesIO()
    Image.new('RGB', (width, height), (40, 80, 120)).save(out, 'PNG')
    return out.getvalue()


# ---------- title-card ----------

def _upload_reference(client, pid, filename='style.png'):
    resp = client.post(
        f'/api/projects/{pid}/reference-images',
        files={'file': (filename, b'fake-png-bytes', 'image/png')},
    )
    return resp.json()['reference_images'][-1]


def _poll_title_card_until_done(client, pid, job_id, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = client.get(f'/api/projects/{pid}/title-card/jobs/{job_id}').json()
        if job['status'] != 'pending':
            return job
        time.sleep(0.05)
    raise AssertionError('Job did not complete in time')
