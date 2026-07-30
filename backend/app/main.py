from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import storage
from .routers import generation, projects, settings
from .seed import seed_if_empty


@asynccontextmanager
async def lifespan(app: FastAPI):
    seed_if_empty()
    yield


app = FastAPI(title='Versecraft API', lifespan=lifespan)

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
app.include_router(generation.router)

# Serves generated scene images and uploaded reference images
# (app_data/projects/<slug>/images|references/...) at /media/projects/<slug>/....
storage.get_data_root().mkdir(parents=True, exist_ok=True)
app.mount('/media', StaticFiles(directory=str(storage.get_data_root())), name='media')


@app.get('/api/health')
def health():
    return {'status': 'ok'}
