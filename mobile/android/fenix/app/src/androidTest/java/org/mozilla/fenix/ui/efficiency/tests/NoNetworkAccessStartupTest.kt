/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.ui.efficiency.tests

import org.junit.After
import org.junit.Test
import org.mozilla.fenix.customannotations.Critical
import org.mozilla.fenix.helpers.AppAndSystemHelper.setNetworkEnabled
import org.mozilla.fenix.ui.efficiency.helpers.BaseTest
import org.mozilla.fenix.ui.efficiency.selectors.BrowserPageSelectors
import org.mozilla.fenix.ui.efficiency.selectors.MainMenuSelectors

class NoNetworkAccessStartupTest : BaseTest() {

    // Restore the network; the framework won't, and leaving it off poisons later tests.
    @After
    fun reEnableNetwork() {
        setNetworkEnabled(true)
    }

    // TestRail link: https://mozilla.testrail.io/index.php?/cases/view/2240723
    @Critical
    @Test
    fun testPageReloadAfterNetworkInterrupted() {
        on.browserPage.navigateToPage("https://example.com")
        on.browserPage.verifyPageContent("Example Domain")

        setNetworkEnabled(false)

        // Reload while offline, then confirm the error surface drew: its title, image, and Try Again button.
        on.browserPage.mozClick(BrowserPageSelectors.MAIN_MENU_BUTTON)
        on.browserPage.mozClick(MainMenuSelectors.REFRESH_BUTTON)
        on.browserPage.mozVerifyElementsByGroup(BrowserPageSelectors.Group.CONNECTION_FAILURE_ERROR_PAGE)
    }
}
