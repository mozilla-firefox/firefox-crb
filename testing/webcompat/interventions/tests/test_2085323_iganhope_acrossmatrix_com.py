import pytest

URL = "https://iganhope.acrossmatrix.com/en-US/"
BLOCKED_TEXT = "Your browser is not supported"
SIGN_IN_TEXT = "Sign in with your email address"


@pytest.mark.asyncio
@pytest.mark.with_interventions
async def test_enabled(client):
    await client.navigate(URL)
    assert client.await_text(SIGN_IN_TEXT, timeout=20)
    assert not client.find_text(BLOCKED_TEXT)


@pytest.mark.asyncio
@pytest.mark.without_interventions
async def test_disabled(client):
    await client.navigate(URL)
    assert client.await_text(BLOCKED_TEXT, timeout=20)
