import pytest

URL = "https://www.jpopsingles.eu/"

BLOCKED_TEXT = "not available on visitor browser"
SUPPORTED_CSS = "form.search-form"


async def is_blocked(client):
    await client.navigate(URL)
    blocked, supported = client.await_first_element_of(
        [client.text(BLOCKED_TEXT), client.css(SUPPORTED_CSS)],
        is_displayed=True,
        timeout=20,
    )
    return blocked is not None


@pytest.mark.asyncio
@pytest.mark.with_interventions
async def test_enabled(client):
    assert not await is_blocked(client)


@pytest.mark.asyncio
@pytest.mark.without_interventions
async def test_disabled(client):
    assert await is_blocked(client)
