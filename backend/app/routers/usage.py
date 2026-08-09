from fastapi import APIRouter, Body, HTTPException

from .. import pricing, storage, usage
from .settings import DEFAULT_SETTINGS

router = APIRouter(prefix='/api/usage', tags=['usage'])


def _overrides() -> dict:
    settings = {**DEFAULT_SETTINGS, **storage.load_settings()}
    return settings.get('pricing_overrides') or {}


def _known_models() -> dict[str, str]:
    """Every composite id the Settings "Models" catalog knows about, mapped
    to 'text'/'image', so the Prices tab can list a model before anyone has
    priced it."""
    model_catalog = storage.load_model_catalog()
    known = {}
    for provider, entry in model_catalog.get('text', {}).items():
        for m in entry.get('models', []):
            if m.get('id'):
                known[f"{provider}:{m['id']}"] = 'text'
    for provider, entry in model_catalog.get('image', {}).items():
        for m in entry.get('models', []):
            if m.get('id'):
                known[f"{provider}:{m['id']}"] = 'image'
    for provider, entry in model_catalog.get('video', {}).items():
        for m in entry.get('models', []):
            if m.get('id'):
                known[f"{provider}:{m['id']}"] = 'video'
    return known


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


@router.get('/period-totals')
def period_totals(tz_offset: int = 0):
    return usage.period_totals(tz_offset=tz_offset, overrides=_overrides())


@router.get('/pricing')
def get_pricing():
    overrides = _overrides()
    return {
        'pricing_version': pricing.PRICING_VERSION,
        'currency': pricing.CURRENCY,
        'models': pricing.catalog_with_known_models(overrides, _known_models()),
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
        'models': pricing.catalog_with_known_models(overrides, _known_models()),
        'overrides': overrides,
    }
