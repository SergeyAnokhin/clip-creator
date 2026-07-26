import re

_INVALID_CHARS = re.compile(r'[\\/:*?"<>|]')


def make_slug(author: str, title: str) -> str:
    """Builds the "[Author] - [Title]" project folder name from spec 1.1,
    replacing filesystem-unsafe characters with an underscore."""
    name = f"{author} - {title}"
    name = _INVALID_CHARS.sub('_', name)
    return name.strip(' .')
