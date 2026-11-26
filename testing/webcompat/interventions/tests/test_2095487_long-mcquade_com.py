import pytest

URL = "https://www.long-mcquade.com/"
DROPDOWN_CSS = "button.dropdownHome"


async def is_bootstrap_working(client):
    await client.navigate(URL, wait="load")
    await client.stall(2)
    return client.execute_script(
        "return typeof bootstrap === 'object' && !!window.jQuery?.fn?.dropdown"
    )


@pytest.mark.asyncio
@pytest.mark.with_interventions
async def test_enabled(client):
    assert await is_bootstrap_working(client)
    client.await_css(DROPDOWN_CSS, is_displayed=True).click()
    await client.stall(1)
    assert client.execute_script(
        "return !!document.querySelector('button.dropdownHome[aria-expanded=true], .modal.show')"
    )


@pytest.mark.asyncio
@pytest.mark.without_interventions
async def test_disabled(client):
    assert not await is_bootstrap_working(client)
