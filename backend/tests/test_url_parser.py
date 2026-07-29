from app.providers.url_parser import extract


def test_extract_prefers_h1_and_meta_author_and_pre_text():
    html = """
    <html><head><title>Зимнее утро | Poems Site</title>
    <meta name="author" content="Александр Пушкин"></head>
    <body>
      <nav>Меню сайта</nav>
      <h1>Зимнее утро</h1>
      <pre>Мороз и солнце; день чудесный!<br>Ещё ты дремлешь, друг прелестный.</pre>
      <footer>Copyright 2026</footer>
    </body></html>
    """
    result = extract(html)
    assert result == {
        'author': 'Александр Пушкин',
        'title': 'Зимнее утро',
        'raw_text': 'Мороз и солнце; день чудесный!\nЕщё ты дремлешь, друг прелестный.',
    }


def test_extract_falls_back_to_title_tag_and_strips_site_suffix():
    html = '<html><head><title>Зимнее утро - Poems Site</title></head><body><article>Текст стиха</article></body></html>'
    result = extract(html)
    assert result['title'] == 'Зимнее утро'
    assert result['author'] == ''
    assert result['raw_text'] == 'Текст стиха'


def test_extract_collapses_extra_blank_lines_from_block_tags():
    html = '<html><body><article><p>Строка один</p><p></p><p></p><p>Строка два</p></article></body></html>'
    result = extract(html)
    assert result['raw_text'] == 'Строка один\n\nСтрока два'


def test_extract_ignores_incidental_newline_after_br_but_keeps_double_br_as_blank_line():
    html = (
        '<html><body><pre>Строка один<br />\n'
        'Строка два<br />\n'
        '<br />\n'
        'Строка три</pre></body></html>'
    )
    result = extract(html)
    assert result['raw_text'] == 'Строка один\nСтрока два\n\nСтрока три'


def test_extract_ignores_html_comments():
    html = '<html><body><article><p>Строка один</p><!-- debug info --></article></body></html>'
    result = extract(html)
    assert result['raw_text'] == 'Строка один'


def test_extract_ignores_source_indentation_between_sibling_tags():
    html = """
    <html><body>
      <article>
        <p>Строка один</p>
        <p>Строка два</p>
        <p>Строка три</p>
      </article>
    </body></html>
    """
    result = extract(html)
    assert result['raw_text'] == 'Строка один\nСтрока два\nСтрока три'
