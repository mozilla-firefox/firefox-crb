import pytest

URL = "https://edu-tlf.szhuaxi.net/xj-mod_login-referer_school.html"

PASSWORD_CSS = "input[type=password]"
UNSUPPORTED_TEXT = "当前浏览器或版本不支持"


@pytest.mark.asyncio
@pytest.mark.with_interventions
async def test_enabled(client):
    await client.navigate(URL)
    assert client.await_css(PASSWORD_CSS, is_displayed=True)
    assert not client.find_text(UNSUPPORTED_TEXT)


@pytest.mark.asyncio
@pytest.mark.without_interventions
async def test_disabled(client):
    await client.navigate(URL)
    assert client.await_text(UNSUPPORTED_TEXT, is_displayed=True)
    assert not client.find_css(PASSWORD_CSS)
