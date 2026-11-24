import pytest

URL = "https://www.minorpatch.com/"
CARD_CSS = ".app-card h3.title"


async def does_card_open(client):
    await client.navigate(URL)
    client.await_css(CARD_CSS, is_displayed=True)
    await client.stall(2)
    client.await_css(CARD_CSS, is_displayed=True).click()
    await client.stall(5)
    return "/apps/" in client.current_url


@pytest.mark.asyncio
@pytest.mark.with_interventions
async def test_enabled(client):
    assert await does_card_open(client)


@pytest.mark.asyncio
@pytest.mark.without_interventions
async def test_disabled(client):
    assert not await does_card_open(client)
