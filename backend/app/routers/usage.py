from fastapi import APIRouter, Body, HTTPException

from .. import pricing, storage, usage
from .settings import DEFAULT_SETTINGS

router = APIRouter(prefix='/api/usage', tags=['usage'])


def _overrides() -> dict:
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    return settings.get('pricing_overrides') or {}


@router.get('/records')
def list_records(
    project_id: str | None = None, task: str | None = None, provider: str | None = None,
    model: str | None = None, status: str | None = None,
    date_from: str | None = None, date_to: str | None = None,
    limit: int = 100, offset: int = 0,
):
    return usage.query(
        project_id=project_id, task=task, provider=provider, model=model, status=status,
        date_from=date_from, date_to=date_to, limit=limit, offset=offset, overrides=_overrides(),
    )


@router.get('/summary')
def summarize(
    group_by: str = 'day', tz_offset: int = 0,
    project_id: str | None = None, task: str | None = None, provider: str | None = None,
    model: str | None = None, status: str | None = None,
    date_from: str | None = None, date_to: str | None = None,
):
    return usage.summarize(
        group_by=group_by, tz_offset=tz_offset,
        project_id=project_id, task=task, provider=provider, model=model, status=status,
        date_from=date_from, date_to=date_to, overrides=_overrides(),
    )


@router.get('/today')
def today(tz_offset: int = 0):
    return usage.today_total(tz_offset=tz_offset, overrides=_overrides())


@router.get('/pricing')
def get_pricing():
    overrides = _overrides()
    return {
        'pricing_version': pricing.PRICING_VERSION,
        'currency': pricing.CURRENCY,
        'models': pricing.catalog(overrides),
        'overrides': overrides,
    }


@router.put('/pricing')
def put_pricing(body: dict = Body(...)):
    overrides = body.get('pricing_overrides')
    if overrides is None:
        raise HTTPException(422, 'pricing_overrides is required')
    error = pricing.validate_overrides(overrides)
    if error:
        raise HTTPException(422, error)

    settings = {**DEFAULT_SETTINGS, **storage.load_settings(), 'pricing_overrides': overrides}
    storage.save_settings(settings)
    return {
        'pricing_version': pricing.PRICING_VERSION,
        'currency': pricing.CURRENCY,
        'models': pricing.catalog(overrides),
        'overrides': overrides,
    }
