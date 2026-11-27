/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.service.fxa

import mozilla.components.concept.fxa.FxaService
import mozilla.components.concept.sync.AuthType
import org.junit.Assert.assertEquals
import org.junit.Test

class TypesTest {
    @Test
    fun `OAuth actions retain the service in their auth type`() {
        val service = FxaService.Sync

        assertEquals(AuthType.Signin(service), "signin".toAuthType(service))
        assertEquals(AuthType.Signup(service), "signup".toAuthType(service))
        assertEquals(AuthType.Pairing(service), "pairing".toAuthType(service))
        assertEquals(AuthType.OtherExternal("new-action", service), "new-action".toAuthType(service))
    }

    @Test
    fun `OAuth actions without a service remain supported`() {
        assertEquals(AuthType.Signin(), "signin".toAuthType())
        assertEquals(AuthType.Signup(), "signup".toAuthType())
        assertEquals(AuthType.Pairing(), "pairing".toAuthType())
        assertEquals(AuthType.OtherExternal("new-action"), "new-action".toAuthType())
    }
}
