from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers import generation, projects, settings
from .seed import seed_if_empty


@asynccontextmanager
async def lifespan(app: FastAPI):
    seed_if_empty()
    yield


app = FastAPI(title='Versecraft API', lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=['http://localhost:5174'],
    allow_methods=['*'],
    allow_headers=['*'],
)

app.include_router(projects.router)
app.include_router(settings.router)
app.include_router(generation.router)


@app.get('/api/health')
def health():
    return {'status': 'ok'}
