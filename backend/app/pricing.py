"""Price catalog and cost math for AI calls.

Pure data + arithmetic: no network, no disk, no imports from `usage.py` (the
dependency runs `providers/* -> app.usage -> app.pricing`, never back).

Models are keyed by the same composite `"{provider}:{model_id}"` string used
everywhere else in the app (see `settings.text_models` / `image_models`).

`BUILTIN_PRICING` used to ship pre-filled with prices "seeded from memory" -
guesses, not looked up - and there was no way to tell those apart from a
number the user had actually verified; both looked like an equally confident
price in the UI. It was emptied out for that reason, then repopulated (2026-07-31)
with the rows below - each one looked up against the provider's current
pricing page or its own listing on openrouter.ai, with a source URL on the
row (Google's and OpenRouter's full pricing/model pages were pasted in by
the user, hence their disproportionate coverage). Every other model still
comes from
`settings.pricing_overrides` (entered by hand in Settings -> Prices, or
imported from a JSON file - see `PricingPanel.jsx`'s Export/Import), so
`catalog()`'s `source` field is `'builtin'` only for a row that was actually
checked, `'override'` for a user-entered one, and a model with neither just
shows as unpriced ("price ?") rather than a plausible-looking wrong number.

If a price is ever added or corrected here, it must be an actually verified
number with its source cited in a comment, not a recalled one - and
`PRICING_VERSION` should be bumped, since catalog costs are recomputed on
every read (see `usage.query`) and a version bump is the only signal the UI
has that the catalog changed. Prices drift and models get deprecated or
shut down (`deepseek-chat` / `deepseek-reasoner`, model ids this app used to
hardcode, are gone entirely as of this pass, replaced by newer generations
below; several `gemini-2.0-*` and `imagen-4.0-*` ids are still priced but
flagged deprecated-with-a-shutdown-date on their row) - re-verify rather
than trust an old comment date.

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

# Every row below was looked up on 2026-07-31, not recalled - see the source
# comment on each one. Anything not listed here is genuinely unpriced; add a
# row only after checking the provider's current page, never from memory.
BUILTIN_PRICING: dict[str, dict] = {
    # ---- Google Gemini: https://ai.google.dev/gemini-api/docs/pricing
    # (full page pasted by the user, dated 2026-07-30 UTC on the page itself) ----
    # Standard-tier rate; where a model lists a separate audio/video rate,
    # this is the text/image/video number, matching the app's own units
    # (which never carry an audio modality). Tiered-by-context models use
    # the <=200k-token rate.
    'google:gemini-3.6-flash': {'kind': 'text', 'input': 1.50, 'output': 7.50},
    'google:gemini-3.5-flash': {'kind': 'text', 'input': 1.50, 'output': 9.00},
    'google:gemini-3.5-flash-lite': {'kind': 'text', 'input': 0.30, 'output': 2.50},
    'google:gemini-3.1-flash-lite': {'kind': 'text', 'input': 0.25, 'output': 1.50},
    # Text-output rate; video output is billed separately (17.50/1M) and has
    # no field in this app's price row shape.
    'google:gemini-omni-flash-preview': {'kind': 'text', 'input': 1.50, 'output': 9.00},
    'google:gemini-3.1-pro-preview': {'kind': 'text', 'input': 2.00, 'output': 12.00},
    # Same rate as gemini-3.1-pro-preview per Google's own pricing page.
    'google:gemini-3.1-pro-preview-customtools': {'kind': 'text', 'input': 2.00, 'output': 12.00},
    'google:gemini-3-flash-preview': {'kind': 'text', 'input': 0.50, 'output': 3.00},
    'google:gemini-2.5-pro': {'kind': 'text', 'input': 1.25, 'output': 10.00},
    'google:gemini-2.5-flash': {'kind': 'text', 'input': 0.30, 'output': 2.50},
    'google:gemini-2.5-flash-lite': {'kind': 'text', 'input': 0.10, 'output': 0.40},
    'google:gemini-2.5-flash-lite-preview-09-2025': {'kind': 'text', 'input': 0.10, 'output': 0.40},
    # Deprecated, shut down 2026-06-01 per Google's page - still priced in
    # case older usage-ledger rows reference it.
    'google:gemini-2.0-flash': {'kind': 'text', 'input': 0.10, 'output': 0.40},
    'google:gemini-2.0-flash-lite': {'kind': 'text', 'input': 0.075, 'output': 0.30},
    'google:gemini-robotics-er-2-preview': {'kind': 'text', 'input': 2.00, 'output': 10.00},
    'google:gemini-robotics-er-2-streaming-preview': {'kind': 'text', 'input': 2.00, 'output': 10.00},
    'google:gemini-robotics-er-1.6-preview': {'kind': 'text', 'input': 1.00, 'output': 5.00},
    'google:gemini-2.5-computer-use-preview-10-2025': {'kind': 'text', 'input': 1.25, 'output': 10.00},

    # Image-output models: Google bills these per output token, tiered by
    # resolution: per_image here is the 1024x1024 ("1K") rate, matching how
    # the app already treats every other image model as a single flat price.
    'google:gemini-3.1-flash-image': {'kind': 'image', 'per_image': 0.067},
    'google:gemini-3.1-flash-lite-image': {'kind': 'image', 'per_image': 0.0336},
    'google:gemini-3-pro-image': {'kind': 'image', 'per_image': 0.134},
    'google:gemini-2.5-flash-image': {'kind': 'image', 'per_image': 0.039},
    # Imagen 4.0 - Google's page marks this family deprecated, shutting down
    # 2026-08-17; still billed at these rates until then.
    'google:imagen-4.0-generate-001': {'kind': 'image', 'per_image': 0.04},
    'google:imagen-4.0-fast-generate-001': {'kind': 'image', 'per_image': 0.02},
    'google:imagen-4.0-ultra-generate-001': {'kind': 'image', 'per_image': 0.06},

    # ---- DeepSeek direct API: https://api-docs.deepseek.com/quick_start/pricing
    # (confirmed against the page's own "Models & Pricing" table, pasted in
    # by the user) - deepseek-chat / deepseek-reasoner are gone;
    # deepseek-v4-flash / deepseek-v4-pro are the current generation. ----
    # `input` is the cache-miss rate, `cached_input` the cache-hit rate - see
    # usage._resolved_cost / pricing.compute_cost's cached-token handling.
    # DeepSeek's page also warns of an upcoming peak/off-peak policy (2x
    # these rates 9-12 & 14-18 Beijing time, UTC+8) with no effective date
    # yet - this app has no time-of-day pricing, so costs during peak hours
    # will read low once that policy goes live; re-check this row then.
    'deepseek:deepseek-v4-flash': {'kind': 'text', 'input': 0.14, 'output': 0.28, 'cached_input': 0.0028},
    'deepseek:deepseek-v4-pro': {'kind': 'text', 'input': 0.435, 'output': 0.87, 'cached_input': 0.003625},

    # ---- OpenRouter: openrouter.ai/models (marketplace price, not the same
    # as the underlying provider's own direct-API price). Rerank/embedding
    # models (single price, no output column) and audio/video/TTS models
    # aren't priceable in this app's text/image row shapes, so they're
    # skipped even where OpenRouter lists a number for them. ----
    'openrouter:google/gemini-3.6-flash': {'kind': 'text', 'input': 1.50, 'output': 7.50},
    'openrouter:google/gemini-3.5-flash-lite': {'kind': 'text', 'input': 0.30, 'output': 2.50},
    'openrouter:deepseek/deepseek-v4-flash': {'kind': 'text', 'input': 0.0896, 'output': 0.1792},
    'openrouter:deepseek/deepseek-v4-flash-0731': {'kind': 'text', 'input': 0.09, 'output': 0.18},
    'openrouter:thinkingmachines/inkling-small': {'kind': 'text', 'input': 0.50, 'output': 1.20},
    'openrouter:qwen/qwen3.7-flash': {'kind': 'text', 'input': 0.03, 'output': 0.13},
    'openrouter:anthropic/claude-opus-5': {'kind': 'text', 'input': 5.00, 'output': 25.00},
    'openrouter:anthropic/claude-opus-5-fast': {'kind': 'text', 'input': 10.00, 'output': 50.00},
    'openrouter:inclusionai/ling-3.0-flash:free': {'kind': 'text', 'input': 0, 'output': 0},
    'openrouter:poolside/laguna-s-2.1:free': {'kind': 'text', 'input': 0, 'output': 0},
    # Listed with a "10% off" promo tag on the page - a temporary discount,
    # not a stable list price; re-check before trusting this long-term.
    'openrouter:poolside/laguna-s-2.1': {'kind': 'text', 'input': 0.09, 'output': 0.18},

    # ---- Replicate: https://replicate.com/pricing (pasted in by the user -
    # this is only the page's "billed by input/output" example list, not the
    # full catalog; most models there are billed by hardware-time instead
    # and aren't priceable in this app's flat per-token/per-image shape,
    # so e.g. the meta-llama-3/mixtral/deepseek-v3 text models and the
    # stability-ai image models in CURATED_MODELS/CURATED_IMAGE_MODELS still
    # aren't covered here) ----
    'replicate:black-forest-labs/flux-schnell': {'kind': 'image', 'per_image': 0.003},
    'replicate:black-forest-labs/flux-dev': {'kind': 'image', 'per_image': 0.025},
    'replicate:black-forest-labs/flux-1.1-pro': {'kind': 'image', 'per_image': 0.04},
    'replicate:ideogram-ai/ideogram-v3-quality': {'kind': 'image', 'per_image': 0.09},
    'replicate:recraft-ai/recraft-v3': {'kind': 'image', 'per_image': 0.04},
    'replicate:anthropic/claude-3.7-sonnet': {'kind': 'text', 'input': 3.00, 'output': 15.00},
    'replicate:deepseek-ai/deepseek-r1': {'kind': 'text', 'input': 3.75, 'output': 10.00},

    # ---- FAL: fal.ai's model-comparison pricing page (pasted by the user) +
    # each model's own page for the exact `fal-ai/...` id (the comparison
    # page only shows display names) - billed per megapixel, treated as
    # per-image at FAL's default ~1 output megapixel. That page's video
    # models (Wan 2.5, Kling 2.5 Turbo Pro, Veo 3, Ovi - billed per second
    # or per video) aren't priceable in this app's text/image row shapes. ----
    'fal:fal-ai/flux/dev': {'kind': 'image', 'per_image': 0.025},
    'fal:fal-ai/bytedance/seedream/v4/text-to-image': {'kind': 'image', 'per_image': 0.03},
    'fal:fal-ai/flux-pro/kontext': {'kind': 'image', 'per_image': 0.04},
    'fal:fal-ai/nano-banana': {'kind': 'image', 'per_image': 0.0398},
    'fal:fal-ai/qwen-image': {'kind': 'image', 'per_image': 0.02},

    # ---- Krea: krea.ai's model list (pasted by the user, "from $X" floor
    # price used where tiered). Krea has no discovery API - every model is
    # its own fixed REST path (see image_models.py's module docstring) - so
    # only rows matching an id already confirmed in
    # image_models.CURATED_IMAGE_MODELS are added here; the display names on
    # the pasted page don't reveal the exact path for anything else, and
    # guessing one risks silently mispricing a different model that happens
    # to share the guess. 'bfl/flux-1-dev' and 'openai/gpt-image-2' (the
    # other two curated Krea models) couldn't be matched to a row with
    # confidence - several "Flux ..." / "ChatGPT ..." rows are plausible
    # candidates but none is an unambiguous match. ----
    'krea:krea/krea-2/medium': {'kind': 'image', 'per_image': 0.03},
    'krea:krea/krea-2/large': {'kind': 'image', 'per_image': 0.06},
    'krea:google/imagen-4': {'kind': 'image', 'per_image': 0.042},
    'krea:google/nano-banana-pro': {'kind': 'image', 'per_image': 0.15},
    'krea:ideogram/ideogram-3': {'kind': 'image', 'per_image': 0.063},
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
