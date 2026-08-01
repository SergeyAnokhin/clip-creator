import pytest

from app import pricing

# These tests price fictional 'some:*' composites via explicit overrides
# rather than relying on real entries in BUILTIN_PRICING, so they keep
# working regardless of what's actually verified/priced there at any given
# time (see pricing.py's module docstring for what BUILTIN_PRICING holds).
TEXT_PRICE = {'kind': 'text', 'input': 0.30, 'output': 2.50}
CACHED_TEXT_PRICE = {'kind': 'text', 'input': 0.27, 'output': 1.10, 'cached_input': 0.07}
IMAGE_PRICE = {'kind': 'image', 'per_image': 0.025}


def test_text_cost_from_tokens():
    amount, source = pricing.compute_cost(
        'some:text-model',
        {'input_tokens': 1_000_000, 'output_tokens': 1_000_000},
        {'some:text-model': TEXT_PRICE},
    )
    assert source == 'catalog'
    assert amount == pytest.approx(0.30 + 2.50)


def test_text_cost_scales_with_small_token_counts():
    amount, _ = pricing.compute_cost(
        'some:text-model',
        {'input_tokens': 1000, 'output_tokens': 500},
        {'some:text-model': TEXT_PRICE},
    )
    assert amount == pytest.approx(1000 * 0.30 / 1e6 + 500 * 2.50 / 1e6)


def test_cached_input_tokens_billed_at_the_cheaper_rate():
    amount, _ = pricing.compute_cost(
        'some:cached-model',
        {'input_tokens': 1_000_000, 'output_tokens': 0, 'cached_input_tokens': 400_000},
        {'some:cached-model': CACHED_TEXT_PRICE},
    )
    assert amount == pytest.approx(600_000 * 0.27 / 1e6 + 400_000 * 0.07 / 1e6)


def test_cached_tokens_ignored_when_price_has_no_cached_rate():
    amount, _ = pricing.compute_cost(
        'some:text-model',
        {'input_tokens': 1_000_000, 'output_tokens': 0, 'cached_input_tokens': 500_000},
        {'some:text-model': TEXT_PRICE},
    )
    assert amount == pytest.approx(0.30)


def test_image_cost_multiplies_per_image_price():
    amount, source = pricing.compute_cost(
        'some:image-model', {'images': 4}, {'some:image-model': IMAGE_PRICE},
    )
    assert source == 'catalog'
    assert amount == pytest.approx(4 * 0.025)


def test_unknown_model_yields_none_not_zero():
    amount, source = pricing.compute_cost(
        'someprovider:whatever', {'input_tokens': 100, 'output_tokens': 100},
    )
    assert amount is None
    assert source == 'unknown'


def test_missing_token_counts_yield_unknown_not_zero():
    # Priced via override, so this specifically isolates "units missing" from
    # "price missing" as the reason for the unknown result.
    amount, source = pricing.compute_cost(
        'some:text-model', {'input_tokens': 100}, {'some:text-model': TEXT_PRICE},
    )
    assert amount is None
    assert source == 'unknown'


def test_missing_image_count_yields_unknown():
    amount, source = pricing.compute_cost(
        'some:image-model', {}, {'some:image-model': IMAGE_PRICE},
    )
    assert amount is None
    assert source == 'unknown'


def test_override_beats_builtin(monkeypatch):
    monkeypatch.setitem(pricing.BUILTIN_PRICING, 'some:text-model', {'kind': 'text', 'input': 1.0, 'output': 2.0})
    overrides = {'some:text-model': {'kind': 'text', 'input': 1.0, 'output': 2.0}}
    amount, source = pricing.compute_cost(
        'some:text-model',
        {'input_tokens': 1_000_000, 'output_tokens': 1_000_000},
        overrides,
    )
    assert source == 'catalog'
    assert amount == pytest.approx(3.0)


def test_provider_wildcard_override_prices_unknown_model():
    overrides = {'krea:*': {'kind': 'image', 'per_image': 0.05}}
    amount, _ = pricing.compute_cost('krea:some/brand-new-model', {'images': 2}, overrides)
    assert amount == pytest.approx(0.10)


def test_exact_override_wins_over_wildcard():
    overrides = {
        'krea:*': {'kind': 'image', 'per_image': 0.05},
        'krea:krea/krea-2/medium': {'kind': 'image', 'per_image': 0.01},
    }
    amount, _ = pricing.compute_cost('krea:krea/krea-2/medium', {'images': 1}, overrides)
    assert amount == pytest.approx(0.01)


def test_malformed_override_falls_through_to_builtin(monkeypatch):
    monkeypatch.setitem(pricing.BUILTIN_PRICING, 'some:text-model', TEXT_PRICE)
    # Missing 'output' - a half-filled row must not be treated as a partial price.
    overrides = {'some:text-model': {'kind': 'text', 'input': 99.0}}
    amount, _ = pricing.compute_cost(
        'some:text-model',
        {'input_tokens': 1_000_000, 'output_tokens': 0},
        overrides,
    )
    assert amount == pytest.approx(0.30)


def test_negative_price_is_rejected():
    overrides = {'x:y': {'kind': 'text', 'input': -1.0, 'output': 1.0}}
    assert pricing.get_price('x:y', overrides) is None


def test_get_price_returns_none_for_blank_model():
    assert pricing.get_price('') is None


def test_estimate_known_model():
    result = pricing.estimate(
        'some:text-model', input_tokens=1_000_000, output_tokens=0,
        overrides={'some:text-model': TEXT_PRICE},
    )
    assert result['known'] is True
    assert result['kind'] == 'text'
    assert result['amount'] == pytest.approx(0.30)
    assert result['currency'] == 'USD'


def test_estimate_converts_chars_to_tokens():
    result = pricing.estimate(
        'some:text-model', input_chars=4000, output_tokens=0,
        overrides={'some:text-model': TEXT_PRICE},
    )
    assert result['amount'] == pytest.approx(1000 * 0.30 / 1e6)


def test_estimate_unknown_model_is_none_not_zero():
    result = pricing.estimate('nope:nope', input_tokens=1000, output_tokens=1000)
    assert result['known'] is False
    assert result['amount'] is None


def test_catalog_marks_override_rows():
    overrides = {'some:text-model': {'kind': 'text', 'input': 1.0, 'output': 2.0}}
    rows = {r['model']: r for r in pricing.catalog(overrides)}
    assert rows['some:text-model']['source'] == 'override'
    assert rows['some:text-model']['input'] == 1.0


def test_catalog_marks_builtin_rows(monkeypatch):
    monkeypatch.setitem(pricing.BUILTIN_PRICING, 'some:image-model', IMAGE_PRICE)
    rows = {r['model']: r for r in pricing.catalog()}
    assert rows['some:image-model']['source'] == 'builtin'
    assert rows['some:image-model']['per_image'] == pytest.approx(0.025)


def test_catalog_splits_the_composite_id():
    overrides = {'fal:fal-ai/flux/dev': IMAGE_PRICE}
    row = next(r for r in pricing.catalog(overrides) if r['model'] == 'fal:fal-ai/flux/dev')
    assert row['provider'] == 'fal'
    assert row['model_id'] == 'fal-ai/flux/dev'


def test_every_builtin_row_is_well_formed():
    """Guards against a typo if a verified price is ever hardcoded back in -
    a malformed row would otherwise silently degrade to 'price unknown'."""
    for model, row in pricing.BUILTIN_PRICING.items():
        assert ':' in model, model
        assert pricing._is_valid_row(row), model


def test_app_default_text_model_stays_priced():
    """`useSettings.js`'s DEFAULT_TEXT_MODELS.default ('google:gemini-2.5-flash')
    should have a real builtin price - if this starts failing, the default
    changed and needs a freshly verified row, not a copy-pasted old number."""
    assert pricing.get_price('google:gemini-2.5-flash') is not None


def test_catalog_with_known_models_adds_unpriced_rows():
    known = {'openrouter:some/brand-new-model': 'text', 'krea:some/new-image-model': 'image'}
    rows = {r['model']: r for r in pricing.catalog_with_known_models({}, known)}
    assert rows['openrouter:some/brand-new-model']['source'] == 'catalog'
    assert rows['openrouter:some/brand-new-model']['input'] is None
    assert rows['openrouter:some/brand-new-model']['kind'] == 'text'
    assert rows['krea:some/new-image-model']['kind'] == 'image'


def test_catalog_with_known_models_skips_models_already_priced():
    overrides = {'google:gemini-2.5-flash': TEXT_PRICE}
    known = {'google:gemini-2.5-flash': 'text'}
    rows = [r for r in pricing.catalog_with_known_models(overrides, known) if r['model'] == 'google:gemini-2.5-flash']
    assert len(rows) == 1
    assert rows[0]['source'] == 'override'
    assert rows[0]['input'] == pytest.approx(0.30)


def test_validate_overrides_accepts_valid_rows():
    assert pricing.validate_overrides({
        'google:gemini-2.5-flash': {'kind': 'text', 'input': 0.3, 'output': 2.5},
        'fal:fal-ai/flux/dev': {'kind': 'image', 'per_image': 0.02},
    }) is None


def test_validate_overrides_rejects_bad_row():
    assert pricing.validate_overrides({'google:x': {'kind': 'text', 'input': 0.3}}) is not None


def test_validate_overrides_rejects_key_without_provider():
    assert pricing.validate_overrides({'gemini': {'kind': 'text', 'input': 1, 'output': 1}}) is not None
