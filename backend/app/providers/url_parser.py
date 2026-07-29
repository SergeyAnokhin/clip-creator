import re

import httpx
from bs4 import BeautifulSoup, NavigableString

_STRIP_TAGS = ['script', 'style', 'nav', 'header', 'footer', 'aside', 'form']
_BLOCK_TAGS = ['p', 'div', 'li', 'blockquote', 'section', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']
_TITLE_SEPARATORS = re.compile(r'\s+[|—–-]\s+')
_BLANK_RUN = re.compile(r'\n[ \t]*\n(?:[ \t]*\n)+')


async def parse(url: str) -> dict | None:
    """Fetches a page and extracts a poem's author/title/raw text from it.
    Returns None if the page can't be fetched (network error, non-2xx, ...) -
    callers fall back to the placeholder-project behavior in that case."""
    try:
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=10.0,
            headers={'User-Agent': 'Mozilla/5.0 (compatible; VersecraftBot/1.0)'},
        ) as client:
            resp = await client.get(url)
            resp.raise_for_status()
    except httpx.HTTPError:
        return None
    return extract(resp.text)


def extract(html: str) -> dict:
    """Pure HTML -> {author, title, raw_text} extraction, no network. Kept
    separate from parse() so it's directly unit-testable."""
    soup = BeautifulSoup(html, 'html.parser')
    for tag in soup(_STRIP_TAGS):
        tag.decompose()

    return {
        'author': _extract_author(soup),
        'title': _extract_title(soup),
        'raw_text': _extract_text(soup),
    }


def _extract_title(soup: BeautifulSoup) -> str:
    h1 = soup.find('h1')
    if h1 and h1.get_text(strip=True):
        return h1.get_text(strip=True)
    if soup.title and soup.title.get_text(strip=True):
        # Page <title> often has a " | Site Name" / " - Site Name" suffix.
        return _TITLE_SEPARATORS.split(soup.title.get_text(strip=True), maxsplit=1)[0].strip()
    return ''


def _extract_author(soup: BeautifulSoup) -> str:
    meta = soup.find('meta', attrs={'name': 'author'}) or soup.find('meta', attrs={'property': 'article:author'})
    if meta and meta.get('content', '').strip():
        return meta['content'].strip()
    rel_author = soup.find(attrs={'rel': 'author'})
    if rel_author and rel_author.get_text(strip=True):
        return rel_author.get_text(strip=True)
    return ''


def _extract_text(soup: BeautifulSoup) -> str:
    container = soup.find('pre') or soup.find('article') or soup.find('main') or _largest_text_block(soup) or soup.body or soup
    # Pretty-printed source HTML embeds incidental newline/indentation
    # whitespace at the edges of text nodes (e.g. "<br />\nNext line..." has
    # that leading "\n" as part of the next line's own text node). Left in
    # place, it combines with the line break we insert below for the <br>
    # itself and turns every ordinary line break into a blank line - so
    # only a genuine double <br><br> or an empty <p></p> spacer should
    # produce one. Stripping each text node down to its real content first
    # removes that incidental whitespace while leaving deliberate empty
    # (whitespace-only) nodes between two separators as the empty string.
    # Match plain NavigableString only - not its Comment/CData/... subclasses,
    # which get_text() otherwise (correctly) ignores; replacing one of those
    # with a plain string here would leak invisible comment text into the
    # result (e.g. MediaWiki's "NewPP limit report" debug comment).
    for node in container.find_all(string=lambda s: type(s) is NavigableString):
        stripped = node.strip()
        if stripped != str(node):
            node.replace_with(stripped)
    for br in container.find_all('br'):
        br.replace_with('\n')
    # Block tags (paragraphs, divs, ...) don't imply a line break on their
    # own in get_text() - append an explicit one so each renders on its own
    # line, same as <br>. Two adjacent block tags (e.g. an empty <p></p>
    # used as a spacer) then naturally produce a blank line between stanzas.
    # Only "leaf" block tags (no nested block tag inside them) get one, so a
    # wrapper like <div><p>line</p></div> doesn't count as two line breaks.
    for block in container.find_all(_BLOCK_TAGS):
        if not block.find(_BLOCK_TAGS):
            block.append('\n')
    text = container.get_text()
    text = '\n'.join(line.strip() for line in text.split('\n'))
    text = _BLANK_RUN.sub('\n\n', text)
    return text.strip('\n')


def _largest_text_block(soup: BeautifulSoup):
    candidates = soup.find_all(['div', 'section', 'p'])
    if not candidates:
        return None
    return max(candidates, key=lambda tag: len(tag.get_text(strip=True)), default=None)
