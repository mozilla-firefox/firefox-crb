/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.browser.engine.gecko.ipprotection

import androidx.annotation.OptIn
import androidx.test.ext.junit.runners.AndroidJUnit4
import mozilla.components.ExperimentalAndroidComponentsApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.geckoview.ExperimentalGeckoViewApi
import org.mozilla.geckoview.IPProtectionController.IPProxyException

@OptIn(ExperimentalGeckoViewApi::class)
@kotlin.OptIn(ExperimentalAndroidComponentsApi::class)
@RunWith(AndroidJUnit4::class)
class GeckoIPProtectionHandlerTest {

    @Test
    fun `GIVEN a GeckoView proxy error WHEN it becomes a request error THEN it carries the proxy error code AND the original exception`() {
        val exception = IPProxyException.fromErrorString("network-error")

        val requestError = exception.intoRequestError()

        assertEquals(IPProxyException.ERROR_NETWORK, requestError.errorCode)
        assertSame(exception, requestError.cause)
    }

    @Test
    fun `GIVEN an exception that is not a GeckoView proxy error WHEN it becomes a request error THEN it has no error code AND carries the original exception`() {
        val exception = RuntimeException("rejected")

        val requestError = exception.intoRequestError()

        assertNull(requestError.errorCode)
        assertSame(exception, requestError.cause)
    }
}
