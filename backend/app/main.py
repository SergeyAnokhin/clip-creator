import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import storage
from .request_log import RequestLogMiddleware
from .routers import (
    generation_export,
    generation_music,
    generation_scenes,
    generation_title_card,
    projects,
    settings,
    translate,
    usage,
)
from .seed import seed_if_empty

# `request_log.RequestLogMiddleware` (added below) replaces uvicorn's own
# access log with a quieter, more readable one - disable the built-in one so
# requests aren't logged twice. Must happen at import time: uvicorn's own
# `configure_logging()` runs before it imports this module, so nothing later
# re-enables this logger for the rest of the process.
logging.getLogger('uvicorn.access').disabled = True


@asynccontextmanager
async def lifespan(app: FastAPI):
    seed_if_empty()
    yield


app = FastAPI(title='Versecraft API', lifespan=lifespan)
app.add_middleware(RequestLogMiddleware)

app.add_middleware(
    CORSMiddleware,
    # Regex (not a fixed origin) so multiple local dev sessions can each get
    # their own Vite port (see vite.config.js reading $PORT) without editing
    # this file — single-user local tool, so a same-machine localhost check
    # is enough.
    allow_origin_regex=r'^http://localhost:\d+$',
    allow_methods=['*'],
    allow_headers=['*'],
)

app.include_router(projects.router)
app.include_router(settings.router)
# All four share the `/api/projects` prefix; their path literals
# (`suno`/`mureka`, `scenes`, `title-card`, `video-export`/`editor`) don't
# overlap, so registration order doesn't affect matching.
app.include_router(generation_music.router)
app.include_router(generation_scenes.router)
app.include_router(generation_title_card.router)
app.include_router(generation_export.router)
app.include_router(usage.router)
app.include_router(translate.router)

# Serves generated scene images and uploaded reference images
# (app_data/projects/<slug>/images|references/...) at /media/projects/<slug>/....
storage.get_data_root().mkdir(parents=True, exist_ok=True)
app.mount('/media', StaticFiles(directory=str(storage.get_data_root())), name='media')


@app.get('/api/health')
def health():
    return {'status': 'ok'}
