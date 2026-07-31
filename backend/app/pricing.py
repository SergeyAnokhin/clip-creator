"""Price catalog and cost math for AI calls.

Pure data + arithmetic: no network, no disk, no imports from `usage.py` (the
dependency runs `providers/* -> app.usage -> app.pricing`, never back).

Models are keyed by the same composite `"{provider}:{model_id}"` string used
everywhere else in the app (see `settings.text_models` / `image_models`).

!!! THE PRICES IN `BUILTIN_PRICING` ARE UNVERIFIED PLACEHOLDERS !!!
They were seeded from memory, not from the providers' pricing pages, and
tariffs change. Every entry is marked `# VERIFY`. A wrong number here silently
produces a wrong cost column - it does not fail loudly. Check the provider's
pricing page, fix the number, and bump `PRICING_VERSION`. Because catalog
costs are recomputed on read (see `usage.query`), correcting a price also
fixes the historical rows.

Price row shapes:
    text : {'kind': 'text',  'input': USD per 1M input tokens,
            'output': USD per 1M output tokens,
            'cached_input': USD per 1M cached input tokens (optional)}
    image: {'kind': 'image', 'per_image': USD per generated image}
"""

PRICING_VERSION = '2026-07-31'
CURRENCY = 'USD'

TOKENS_PER_UNIT = 1_000_000
# Rough ex-ante heuristic for turning a prompt's character count into tokens.
# Only used by `estimate()` for the UI's "≈ $0.004" hints, never for billing.
CHARS_PER_TOKEN = 4

_TEXT_KEYS = ('input', 'output')
_IMAGE_KEYS = ('per_image',)

BUILTIN_PRICING: dict[str, dict] = {
    # ---- text: USD per 1M tokens ----
    'google:gemini-2.5-flash': {'kind': 'text', 'input': 0.30, 'output': 2.50},  # VERIFY
    'google:gemini-2.5-flash-lite': {'kind': 'text', 'input': 0.10, 'output': 0.40},  # VERIFY
    'google:gemini-2.5-pro': {'kind': 'text', 'input': 1.25, 'output': 10.00},  # VERIFY (tiered above 200k ctx, flat here)
    'google:gemini-2.0-flash': {'kind': 'text', 'input': 0.10, 'output': 0.40},  # VERIFY
    'google:gemini-2.0-flash-lite': {'kind': 'text', 'input': 0.075, 'output': 0.30},  # VERIFY
    'deepseek:deepseek-chat': {'kind': 'text', 'input': 0.27, 'output': 1.10, 'cached_input': 0.07},  # VERIFY
    'deepseek:deepseek-reasoner': {'kind': 'text', 'input': 0.55, 'output': 2.19},  # VERIFY
    'openrouter:openai/gpt-4o-mini': {'kind': 'text', 'input': 0.15, 'output': 0.60},  # VERIFY
    'openrouter:openai/gpt-4.1-mini': {'kind': 'text', 'input': 0.40, 'output': 1.60},  # VERIFY
    'openrouter:anthropic/claude-3.5-haiku': {'kind': 'text', 'input': 0.80, 'output': 4.00},  # VERIFY
    'openrouter:google/gemini-2.5-flash': {'kind': 'text', 'input': 0.30, 'output': 2.50},  # VERIFY
    'openrouter:deepseek/deepseek-chat': {'kind': 'text', 'input': 0.27, 'output': 1.10},  # VERIFY
    'openrouter:meta-llama/llama-3.3-70b-instruct': {'kind': 'text', 'input': 0.12, 'output': 0.30},  # VERIFY
    'replicate:meta/meta-llama-3-70b-instruct': {'kind': 'text', 'input': 0.65, 'output': 2.75},  # VERIFY
    'replicate:meta/meta-llama-3-8b-instruct': {'kind': 'text', 'input': 0.05, 'output': 0.25},  # VERIFY
    'replicate:mistralai/mixtral-8x7b-instruct-v0.1': {'kind': 'text', 'input': 0.30, 'output': 1.00},  # VERIFY
    'replicate:deepseek-ai/deepseek-v3': {'kind': 'text', 'input': 0.38, 'output': 1.53},  # VERIFY

    # ---- images: USD per generated image ----
    # Ids must stay in sync with providers/image_models.CURATED_IMAGE_MODELS;
    # test_pricing.py::test_curated_image_models_are_priced enforces it.
    'google:imagen-4.0-generate-001': {'kind': 'image', 'per_image': 0.04},  # VERIFY
    'google:imagen-4.0-fast-generate-001': {'kind': 'image', 'per_image': 0.02},  # VERIFY
    'google:imagen-4.0-ultra-generate-001': {'kind': 'image', 'per_image': 0.06},  # VERIFY
    'replicate:black-forest-labs/flux-schnell': {'kind': 'image', 'per_image': 0.003},  # VERIFY
    'replicate:black-forest-labs/flux-dev': {'kind': 'image', 'per_image': 0.025},  # VERIFY
    'replicate:stability-ai/stable-diffusion-3.5-large': {'kind': 'image', 'per_image': 0.065},  # VERIFY
    'replicate:stability-ai/sdxl': {'kind': 'image', 'per_image': 0.002},  # VERIFY
    'fal:fal-ai/flux/schnell': {'kind': 'image', 'per_image': 0.003},  # VERIFY
    'fal:fal-ai/flux/dev': {'kind': 'image', 'per_image': 0.025},  # VERIFY
    'fal:fal-ai/flux-pro/v1.1': {'kind': 'image', 'per_image': 0.04},  # VERIFY
    'fal:fal-ai/fast-sdxl': {'kind': 'image', 'per_image': 0.003},  # VERIFY
    'fal:fal-ai/aura-flow': {'kind': 'image', 'per_image': 0.01},  # VERIFY
    'krea:krea/krea-2/medium': {'kind': 'image', 'per_image': 0.04},  # VERIFY
    'krea:krea/krea-2/large': {'kind': 'image', 'per_image': 0.08},  # VERIFY
    'krea:bfl/flux-1-dev': {'kind': 'image', 'per_image': 0.025},  # VERIFY
    'krea:google/imagen-4': {'kind': 'image', 'per_image': 0.04},  # VERIFY
    'krea:google/nano-banana-pro': {'kind': 'image', 'per_image': 0.14},  # VERIFY
    'krea:ideogram/ideogram-3': {'kind': 'image', 'per_image': 0.08},  # VERIFY
    'krea:openai/gpt-image-2': {'kind': 'image', 'per_image': 0.19},  # VERIFY
}


def _is_valid_row(row) -> bool:
    """A partially-filled row is treated as *unknown*, never as a partial
    price - half a price would understate the cost without saying so."""
    if not isinstance(row, dict):
        return False
    kind = row.get('kind')
    required = _TEXT_KEYS if kind == 'text' else _IMAGE_KEYS if kind == 'image' else None
    if required is None:
        return False
    for key in required:
        value = row.get(key)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
            return False
    cached = row.get('cached_input')
    if cached is not None and (not isinstance(cached, (int, float)) or isinstance(cached, bool) or cached < 0):
        return False
    return True


def get_price(model: str, overrides: dict | None = None) -> dict | None:
    """Resolution order: user override -> built-in catalog -> provider-wide
    `"{provider}:*"` override (an escape hatch for pricing a whole provider at
    once; built-ins never use wildcards). Returns None when nothing valid
    matches."""
    model = (model or '').strip()
    if not model:
        return None
    overrides = overrides or {}

    row = overrides.get(model)
    if _is_valid_row(row):
        return dict(row)

    row = BUILTIN_PRICING.get(model)
    if _is_valid_row(row):
        return dict(row)

    provider, _, _ = model.partition(':')
    row = overrides.get(f'{provider}:*')
    if _is_valid_row(row):
        return dict(row)

    return None


def compute_cost(model: str, units: dict | None, overrides: dict | None = None) -> tuple[float | None, str]:
    """Post-hoc cost from recorded units. Returns `(amount, source)` where
    source is 'catalog' or 'unknown'.

    Returns `(None, 'unknown')` - never `(0.0, ...)` - when the model has no
    price or the provider didn't report the units the price needs. A zero
    would silently understate the total; a None is counted separately and
    surfaced in the UI as "N calls with unknown cost".
    """
    price = get_price(model, overrides)
    if price is None:
        return None, 'unknown'
    units = units or {}

    if price['kind'] == 'text':
        input_tokens = units.get('input_tokens')
        output_tokens = units.get('output_tokens')
        if input_tokens is None or output_tokens is None:
            return None, 'unknown'
        cached = units.get('cached_input_tokens') or 0
        cached_rate = price.get('cached_input')
        if cached_rate is not None and cached:
            cached = min(cached, input_tokens)
            billable_input = input_tokens - cached
            amount = (billable_input * price['input'] + cached * cached_rate) / TOKENS_PER_UNIT
        else:
            amount = input_tokens * price['input'] / TOKENS_PER_UNIT
        amount += output_tokens * price['output'] / TOKENS_PER_UNIT
        return amount, 'catalog'

    images = units.get('images')
    if images is None:
        return None, 'unknown'
    return images * price['per_image'], 'catalog'


def estimate(model: str, *, input_tokens: int = 0, output_tokens: int = 0,
             images: int = 0, input_chars: int | None = None,
             overrides: dict | None = None) -> dict:
    """Ex-ante estimate for the UI, so a model can be compared before it runs.

    `input_chars` is a convenience for the caller that only has a prompt
    string: it is converted with the crude CHARS_PER_TOKEN heuristic, which is
    why the UI labels these numbers with "≈".
    """
    price = get_price(model, overrides)
    if input_chars is not None:
        input_tokens = max(input_tokens, input_chars // CHARS_PER_TOKEN)
    units = {'input_tokens': input_tokens, 'output_tokens': output_tokens, 'images': images}
    amount, source = compute_cost(model, units, overrides)
    return {
        'model': model,
        'kind': price['kind'] if price else None,
        'amount': amount,
        'currency': CURRENCY,
        'known': source != 'unknown',
        'price': price,
    }


def catalog(overrides: dict | None = None) -> list[dict]:
    """Merged built-in + override view for the UI, sorted by composite id."""
    overrides = overrides or {}
    rows = []
    for model in sorted(set(BUILTIN_PRICING) | set(overrides)):
        price = get_price(model, overrides)
        if price is None:
            continue
        provider, _, model_id = model.partition(':')
        rows.append({
            'model': model,
            'provider': provider,
            'model_id': model_id,
            'kind': price['kind'],
            'input': price.get('input'),
            'output': price.get('output'),
            'cached_input': price.get('cached_input'),
            'per_image': price.get('per_image'),
            'source': 'override' if _is_valid_row(overrides.get(model)) else 'builtin',
        })
    return rows


def catalog_with_known_models(overrides: dict | None, known_models: dict[str, str]) -> list[dict]:
    """`catalog()` plus one placeholder row (all prices `None`) for every
    composite in `known_models` (composite -> 'text'/'image', from the
    Settings "Models" catalog) that isn't already priced - so the Prices tab
    can list every model the app knows about, not just the ones someone has
    already priced. Takes the catalog from the caller rather than reading it
    itself, keeping this module free of disk access."""
    rows = catalog(overrides)
    present = {r['model'] for r in rows}
    for composite, kind in known_models.items():
        if composite in present:
            continue
        provider, _, model_id = composite.partition(':')
        rows.append({
            'model': composite, 'provider': provider, 'model_id': model_id, 'kind': kind,
            'input': None, 'output': None, 'cached_input': None, 'per_image': None,
            'source': 'catalog',
        })
    rows.sort(key=lambda r: r['model'])
    return rows


def validate_overrides(overrides: dict) -> str | None:
    """Returns an error message for the first bad entry, or None if all rows
    are usable. Used by `PUT /api/usage/pricing` - a typo'd price would
    otherwise corrupt the whole cost column silently."""
    if not isinstance(overrides, dict):
        return 'pricing_overrides must be an object'
    for model, row in overrides.items():
        if not isinstance(model, str) or not model.strip():
            return 'Model keys must be non-empty strings'
        if ':' not in model:
            return f'Model key must be "provider:model_id": {model}'
        if not _is_valid_row(row):
            return (f'Invalid price for {model}: needs kind="text" with input+output, '
                    'or kind="image" with per_image, all non-negative numbers')
    return None
