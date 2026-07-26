from app.slug import make_slug


def test_builds_author_title_format_for_clean_input():
    assert make_slug('Александр Пушкин', 'Зимнее утро') == 'Александр Пушкин - Зимнее утро'


def test_sanitizes_filesystem_invalid_characters():
    result = make_slug('Иванов: "Поэт"?', 'Стих/Ы*Z')
    assert not any(c in result for c in '\\/:*?"<>|')


def test_strips_trailing_dots_and_spaces():
    result = make_slug('Name.', 'Title ')
    assert result[-1] not in '. '
