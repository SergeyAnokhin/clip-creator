from app.console_log import _RED, _RESET, _YELLOW
from app.request_log import _DIM, _color_for_status, _format


def test_color_for_status_boundaries():
    assert _color_for_status(200) == _DIM
    assert _color_for_status(304) == _DIM
    assert _color_for_status(399) == _DIM
    assert _color_for_status(400) == _YELLOW
    assert _color_for_status(404) == _YELLOW
    assert _color_for_status(499) == _YELLOW
    assert _color_for_status(500) == _RED
    assert _color_for_status(502) == _RED


def test_format_has_no_client_ip_and_uses_method_emoji():
    line = _format('GET', '/api/projects', 200, 12.3)
    assert '127.0.0.1' not in line
    assert '📥' in line
    assert '/api/projects' in line
    assert '200' in line
    assert '(12ms)' in line
    assert line.startswith(_DIM)
    assert line.endswith(_RESET)


def test_format_colors_server_error_red():
    line = _format('POST', '/api/projects/slug/generation', 500, 1.0)
    assert line.startswith(_RED)


def test_format_unknown_method_falls_back_to_globe_emoji():
    line = _format('OPTIONS', '/api/projects', 200, 0.5)
    assert '🌐' in line
