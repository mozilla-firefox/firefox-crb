/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.accounts

import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CreateRestoreCredentialRequest
import androidx.credentials.CreateRestoreCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.RestoreCredential
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.restorecredential.E2eeUnavailableException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import mozilla.components.concept.sync.OAuthAccount
import mozilla.components.concept.sync.Profile
import mozilla.components.service.fxa.manager.AccountState
import mozilla.components.service.fxa.store.SyncStore
import mozilla.components.support.test.any
import mozilla.components.support.test.mock
import mozilla.components.support.test.robolectric.testContext
import mozilla.components.support.test.whenever
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.ArgumentMatchers.anyBoolean as mockitoAnyBoolean
import org.mockito.Mockito.atLeastOnce
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class RestoreCredentialsManagerTest {

    private val testDispatcher = StandardTestDispatcher()
    private val testScope = TestScope(testDispatcher)

    private val credentialManager: CredentialManager = mock()

    private lateinit var manager: RestoreCredentialsManager

    @Before
    fun setUp() {
        manager =
            RestoreCredentialsManager(
                context = testContext,
                coroutineScope = testScope,
                ioDispatcher = testDispatcher,
                credentialManagerProvider = { credentialManager },
            )
    }

    @Test
    fun `createRestoreCredential creates cloud restore key on success`() =
        runTest(testDispatcher) {
            val accountId = "test_user_123"
            val success = manager.createRestoreCredential(accountId)

            assertTrue(success)
            verify(credentialManager).createCredential(any(), any<CreateRestoreCredentialRequest>())
        }

    @Test
    fun `createRestoreCredential falls back to local key when E2eeUnavailableException is thrown`() =
        runTest(testDispatcher) {
            val accountId = "test_user_e2ee"

            whenever(credentialManager.createCredential(any(), any())).thenAnswer { invocation ->
                val req = invocation.getArgument<CreateRestoreCredentialRequest>(1)
                if (req.isCloudBackupEnabled) {
                    throw E2eeUnavailableException("E2EE not available")
                }
                mock<CreateRestoreCredentialResponse>()
            }

            val success = manager.createRestoreCredential(accountId)

            assertTrue(success)
            verify(credentialManager, atLeastOnce()).createCredential(any(), any<CreateRestoreCredentialRequest>())
        }

    @Test
    fun `getRestoreCredential returns authentication response json`() =
        runTest(testDispatcher) {
            val mockResponse: GetCredentialResponse = mock()
            val mockCredential: RestoreCredential = mock()
            val expectedJson = """{"type":"public-key","id":"test_id"}"""

            whenever(mockCredential.authenticationResponseJson).thenReturn(expectedJson)
            whenever(mockResponse.credential).thenReturn(mockCredential)
            whenever(credentialManager.getCredential(any(), any<GetCredentialRequest>())).thenReturn(mockResponse)

            val result = manager.getRestoreCredential()

            assertEquals(expectedJson, result)
            verify(credentialManager).getCredential(any(), any<GetCredentialRequest>())
        }

    @Test
    fun `clearRestoreCredential calls clearCredentialState with TYPE_CLEAR_RESTORE_CREDENTIAL`() =
        runTest(testDispatcher) {
            val success = manager.clearRestoreCredential()

            assertTrue(success)
            verify(credentialManager).clearCredentialState(any<ClearCredentialStateRequest>())
        }

    @Test
    fun `onReady does not trigger credential creation when account is already authenticated`() =
        runTest(testDispatcher) {
            val account: OAuthAccount = mock()
            val profile = Profile(uid = "user_456", email = "test@example.com", avatar = null, displayName = "Test")
            whenever(account.getProfile(mockitoAnyBoolean())).thenReturn(profile)

            manager.onReady(account)
            testDispatcher.scheduler.advanceUntilIdle()

            verify(credentialManager, never()).createCredential(any(), any())
        }

    @Test
    fun `onReady triggers getRestoreCredential when account is null`() =
        runTest(testDispatcher) {
            whenever(credentialManager.getCredential(any(), any<GetCredentialRequest>())).thenAnswer {
                throw NoCredentialException("No credentials")
            }

            manager.onReady(null)
            testDispatcher.scheduler.advanceUntilIdle()

            verify(credentialManager).getCredential(any(), any<GetCredentialRequest>())
        }

    @Test
    fun `onLoggedOut triggers clearRestoreCredential`() =
        runTest(testDispatcher) {
            manager.onLoggedOut()
            testDispatcher.scheduler.advanceUntilIdle()

            verify(credentialManager).clearCredentialState(any())
        }

    @Test
    fun `onProfileUpdated triggers createRestoreCredential when profile is updated`() =
        runTest(testDispatcher) {
            val profile =
                Profile(
                    uid = "user_profile_123",
                    email = "profile@example.com",
                    avatar = null,
                    displayName = "Profile Test",
                )

            manager.onProfileUpdated(profile)
            testDispatcher.scheduler.advanceUntilIdle()

            verify(credentialManager).createCredential(any(), any<CreateRestoreCredentialRequest>())
        }

    @Test
    fun `onAuthenticationProblems does not clear restore credential`() =
        runTest(testDispatcher) {
            manager.onAuthenticationProblems()
            testDispatcher.scheduler.advanceUntilIdle()

            verify(credentialManager, never()).clearCredentialState(any())
        }

    @Test
    fun `restoreAccountIdentity recognizes identity via SyncStore`() =
        runTest(testDispatcher) {
            val syncStore = SyncStore()
            val simplifiedManager =
                RestoreCredentialsManager(
                    context = testContext,
                    syncStore = syncStore,
                    coroutineScope = testScope,
                    ioDispatcher = testDispatcher,
                    credentialManagerProvider = { credentialManager },
                )
            val accountId = "test_user_789"
            val encodedUserHandle =
                android.util.Base64.encodeToString(
                    accountId.toByteArray(Charsets.UTF_8),
                    android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING,
                )
            val assertionJson = """{"response":{"userHandle":"$encodedUserHandle"}}"""
            val mockResponse: GetCredentialResponse = mock()
            val mockCredential: RestoreCredential = mock()
            whenever(mockCredential.authenticationResponseJson).thenReturn(assertionJson)
            whenever(mockResponse.credential).thenReturn(mockCredential)
            whenever(credentialManager.getCredential(any(), any<GetCredentialRequest>())).thenReturn(mockResponse)

            val success = simplifiedManager.restoreAccountIdentity()

            assertTrue(success)
            assertEquals(accountId, syncStore.state.account?.uid)
            assertEquals(AccountState.RestoredIdentity, syncStore.state.accountState)
        }

    @Test
    fun `restoreAccountIdentity returns false when no account id can be recovered`() =
        runTest(testDispatcher) {
            val syncStore = SyncStore()
            val simplifiedManager =
                RestoreCredentialsManager(
                    context = testContext,
                    syncStore = syncStore,
                    coroutineScope = testScope,
                    ioDispatcher = testDispatcher,
                    credentialManagerProvider = { credentialManager },
                )
            val mockResponse: GetCredentialResponse = mock()
            val mockCredential: RestoreCredential = mock()
            whenever(mockCredential.authenticationResponseJson).thenReturn("""{"response":{}}""")
            whenever(mockResponse.credential).thenReturn(mockCredential)
            whenever(credentialManager.getCredential(any(), any<GetCredentialRequest>())).thenReturn(mockResponse)

            val success = simplifiedManager.restoreAccountIdentity()

            assertFalse(success)
            assertNull(syncStore.state.account)
        }

    @Test
    fun `onLoggedOut clears restore credential key from CredentialManager`() =
        runTest(testDispatcher) {
            val syncStore = SyncStore()
            val localManager =
                RestoreCredentialsManager(
                    context = testContext,
                    syncStore = syncStore,
                    coroutineScope = testScope,
                    ioDispatcher = testDispatcher,
                    credentialManagerProvider = { credentialManager },
                )

            val accountId = "test_user_789"
            val encodedUserHandle =
                android.util.Base64.encodeToString(
                    accountId.toByteArray(Charsets.UTF_8),
                    android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING,
                )
            val assertionJson = """{"response":{"userHandle":"$encodedUserHandle"}}"""
            val mockResponse: GetCredentialResponse = mock()
            val mockCredential: RestoreCredential = mock()
            whenever(mockCredential.authenticationResponseJson).thenReturn(assertionJson)
            whenever(mockResponse.credential).thenReturn(mockCredential)
            whenever(credentialManager.getCredential(any(), any<GetCredentialRequest>())).thenReturn(mockResponse)

            localManager.onReady(null)
            testDispatcher.scheduler.advanceUntilIdle()

            assertEquals(accountId, syncStore.state.account?.uid)
            assertEquals(AccountState.RestoredIdentity, syncStore.state.accountState)

            localManager.onLoggedOut()
            testDispatcher.scheduler.advanceUntilIdle()

            verify(credentialManager).clearCredentialState(any<ClearCredentialStateRequest>())
        }

    @Test
    fun `createRestoreCredential can be called repeatedly`() =
        runTest(testDispatcher) {
            val accountId = "test_user_repeat"

            val result1 = manager.createRestoreCredential(accountId)
            val result2 = manager.createRestoreCredential(accountId)

            assertTrue(result1)
            assertTrue(result2)
            verify(credentialManager, org.mockito.Mockito.times(2))
                .createCredential(any(), any<CreateRestoreCredentialRequest>())
        }
}
