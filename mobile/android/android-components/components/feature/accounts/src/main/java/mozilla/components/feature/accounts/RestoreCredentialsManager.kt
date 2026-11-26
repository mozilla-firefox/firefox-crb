/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.accounts

import android.content.Context
import android.util.Base64
import androidx.annotation.VisibleForTesting
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CreateRestoreCredentialRequest
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetRestoreCredentialOption
import androidx.credentials.RestoreCredential
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.restorecredential.CreateRestoreCredentialDomException
import androidx.credentials.exceptions.restorecredential.E2eeUnavailableException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import mozilla.components.concept.sync.AccountObserver
import mozilla.components.concept.sync.AuthType
import mozilla.components.concept.sync.OAuthAccount
import mozilla.components.concept.sync.Profile
import mozilla.components.service.fxa.manager.AccountState
import mozilla.components.service.fxa.store.Account
import mozilla.components.service.fxa.store.SyncAction
import mozilla.components.service.fxa.store.SyncStore
import mozilla.components.support.base.log.logger.Logger
import org.json.JSONException
import org.json.JSONObject

/**
 * Manages Android Credential Manager Restore Credentials for Firefox Sync Account.
 *
 * Implements Android Credential Manager Restore Credentials flow:
 * 1. Creates a restore key when a user signs in with Firefox Sync account.
 * 2. Retrieves a restore key on device setup / first launch to recognize previously signed-in account identity.
 * 3. Deletes the restore key when the user signs out.
 *
 * Restore credential state is managed directly via Credential Manager APIs without depending on local app data backup
 * or SharedPreferences.
 *
 * @param syncStore Used to surface a recognized identity in the sync store.
 * @param coroutineScope Scope used to launch fire-and-forget work.
 * @param ioDispatcher Dispatcher used to run Credential Manager operations.
 */
class RestoreCredentialsManager(
    private val context: Context,
    private val syncStore: SyncStore? = null,
    private val coroutineScope: CoroutineScope,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    @get:VisibleForTesting internal val credentialManagerProvider: ((Context) -> CredentialManager)? = null,
) : AccountObserver {

    private val logger = Logger("RestoreCredentialsManager")
    private val credentialManager: CredentialManager by lazy {
        credentialManagerProvider?.invoke(context) ?: CredentialManager.create(context)
    }

    /** Triggers credential restoration if no local authenticated account exists on app start. */
    override fun onReady(authenticatedAccount: OAuthAccount?) {
        if (authenticatedAccount == null) {
            coroutineScope.launch {
                restoreAccountIdentity()
            }
        }
    }

    /** Creates a restore credential when an account is authenticated. */
    override fun onAuthenticated(account: OAuthAccount, authType: AuthType) {
        coroutineScope.launch {
            val profile = account.getProfile()
            val accountId = profile?.uid
            if (!accountId.isNullOrEmpty()) {
                createRestoreCredential(accountId)
            }
        }
    }

    /** Creates or updates a restore credential when an account profile is updated. */
    override fun onProfileUpdated(profile: Profile) {
        coroutineScope.launch {
            val accountId = profile.uid
            if (!accountId.isNullOrEmpty()) {
                createRestoreCredential(accountId)
            }
        }
    }

    /** Clears the restore credential state when the account logs out. */
    override fun onLoggedOut() {
        clearRestoreCredentialAsync()
    }

    /**
     * Creates a restore key using Android Credential Manager with cloud backup and local fallback.
     *
     * @param accountId Unique Firefox Account ID.
     * @param creationJson Optional custom WebAuthn creation options JSON.
     */
    suspend fun createRestoreCredential(
        accountId: String,
        creationJson: String? = null,
    ): Boolean =
        withContext(ioDispatcher) {
            if (accountId.isBlank()) {
                logger.warn("Cannot create restore credential for blank account ID.")
                return@withContext false
            }

            val requestJson = creationJson ?: generateDefaultCreationJson(accountId)

            createCloudBackedCredential(requestJson)
        }

    /** Attempts to create a cloud-backed restore key (`isCloudBackupEnabled = true`). */
    private suspend fun createCloudBackedCredential(requestJson: String): Boolean {
        return try {
            val request =
                CreateRestoreCredentialRequest(
                    requestJson = requestJson,
                    isCloudBackupEnabled = true,
                )
            credentialManager.createCredential(context, request)
            logger.info("Successfully created cloud-backed restore credential.")
            true
        } catch (e: E2eeUnavailableException) {
            logger.info("E2EE unavailable for cloud backup, retrying with local restore key: ${e.message}")
            createLocalCredential(requestJson)
        } catch (e: CreateCredentialException) {
            logCredentialCreationError(e)
            false
        }
    }

    /** Creates a local restore key (`isCloudBackupEnabled = false`) when cloud backup is unavailable. */
    private suspend fun createLocalCredential(requestJson: String): Boolean {
        return try {
            val localRequest =
                CreateRestoreCredentialRequest(
                    requestJson = requestJson,
                    isCloudBackupEnabled = false,
                )
            credentialManager.createCredential(context, localRequest)
            logger.info("Successfully created local restore credential.")
            true
        } catch (retryEx: CreateCredentialException) {
            logger.error("Failed to create local restore credential on fallback: ${retryEx.message}", retryEx)
            false
        }
    }

    /** Logs specific Credential Manager creation errors. */
    private fun logCredentialCreationError(e: CreateCredentialException) {
        when (e) {
            is CreateRestoreCredentialDomException ->
                logger.error("Invalid WebAuthn JSON format for restore credential: ${e.message}", e)
            else -> logger.error("Failed to create restore credential: ${e.message}", e)
        }
    }

    /** Retrieves restore credentials and recognizes previously signed-in account identity. */
    suspend fun restoreAccountIdentity(): Boolean =
        withContext(ioDispatcher) {
            val restoredJson = getRestoreCredential()
            if (restoredJson.isNullOrEmpty()) {
                return@withContext false
            }
            logger.info("Restored credential retrieved from Credential Manager.")
            recognizeRestoredIdentity(restoredJson)
        }

    /** Retrieves the restore key from Credential Manager. */
    suspend fun getRestoreCredential(requestJson: String? = null): String? =
        withContext(ioDispatcher) {
            val authenticationJson = requestJson ?: generateDefaultAuthenticationJson()
            val option = GetRestoreCredentialOption(authenticationJson)
            val request = GetCredentialRequest(listOf(option))

            try {
                val response: GetCredentialResponse = credentialManager.getCredential(context, request)
                val restoreCredential = response.credential as? RestoreCredential
                val credentialResponseJson = restoreCredential?.authenticationResponseJson
                if (credentialResponseJson != null) {
                    logger.info("Successfully retrieved restore credential from Credential Manager.")
                }
                credentialResponseJson
            } catch (e: GetCredentialException) {
                logger.debug("No restore credential retrieved: ${e.message}")
                null
            }
        }

    /** Asynchronously clears the restore credential state. */
    fun clearRestoreCredentialAsync() {
        coroutineScope.launch {
            clearRestoreCredential()
        }
    }

    /** Deletes the restore key from Android Credential Manager when the user signs out. */
    suspend fun clearRestoreCredential(): Boolean =
        withContext(ioDispatcher) {
            try {
                val clearRequest =
                    ClearCredentialStateRequest(ClearCredentialStateRequest.TYPE_CLEAR_RESTORE_CREDENTIAL)
                credentialManager.clearCredentialState(clearRequest)
                logger.info("Successfully cleared restore credential state.")
                true
            } catch (e: ClearCredentialException) {
                logger.error("Failed to clear restore credential state: ${e.message}", e)
                false
            }
        }

    /** Recovers the account ID from assertion `userHandle` and prompts sign-in. */
    private fun recognizeRestoredIdentity(assertionJson: String): Boolean {
        val accountId = extractAccountId(assertionJson)
        if (accountId.isNullOrEmpty()) {
            logger.warn("Could not recover account id from the restored credential.")
            return false
        }

        syncStore?.let { store ->
            val account = Account(uid = accountId, email = null, avatar = null, displayName = null)
            store.dispatch(SyncAction.UpdateAccount(account))
            store.dispatch(SyncAction.UpdateAccountState(AccountState.RestoredIdentity))
        }

        logger.info("Recognized previously signed-in account from restore credential; prompting sign-in.")
        return true
    }

    /** Parses assertion JSON and extracts the base64url-decoded account ID from `userHandle`. */
    private fun extractAccountId(assertionJson: String): String? {
        return try {
            val userHandle = JSONObject(assertionJson).optJSONObject("response")?.optString("userHandle")
            userHandle?.takeIf { it.isNotEmpty() }?.let(::decodeAccountId)
        } catch (e: JSONException) {
            logger.error("Failed to parse restore credential assertion JSON: ${e.message}", e)
            null
        }
    }

    companion object {
        private const val USER_ID_BASE64_FLAGS = Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING

        /** Encodes [accountId] to base64url for the `user.id` field. */
        private fun encodeAccountId(accountId: String): String =
            Base64.encodeToString(accountId.toByteArray(Charsets.UTF_8), USER_ID_BASE64_FLAGS)

        /** Decodes base64url [value] from `userHandle` back to account ID. */
        private fun decodeAccountId(value: String): String? =
            try {
                String(Base64.decode(value, USER_ID_BASE64_FLAGS), Charsets.UTF_8)
            } catch (_: IllegalArgumentException) {
                null
            }

        /**
         * Generates the default WebAuthn `PublicKeyCredentialCreationOptionsJSON` payload required by Android
         * Credential Manager's [CreateRestoreCredentialRequest] API to create a restore key.
         *
         * The Android Credential Manager API strictly requires valid WebAuthn JSON structure. The current
         * implementation intentionally generates compliant WebAuthn options locally because restore credentials are
         * being used for account recognition (prompting sign-in via existing FxA OAuth flow), rather than full passkey
         * authentication. The [accountId] is base64url-encoded into `user.id` so it can be losslessly recovered from
         * the assertion's `userHandle` during identity restoration.
         *
         * Note: When dynamic FxA server WebAuthn endpoints are integrated in the future, server-issued options can
         * override this default payload.
         */
        private fun generateDefaultCreationJson(accountId: String): String {
            return """
            {
                "rp": {
                    "name": "Firefox Sync",
                    "id": "accounts.firefox.com"
                },
                "user": {
                    "id": "${encodeAccountId(accountId)}",
                    "name": "$accountId",
                    "displayName": "Firefox User"
                },
                "challenge": "d2hpY2ggaXMgYSByYW5kb20gY2hhbGxlbmdl",
                "pubKeyCredParams": [
                    {
                        "type": "public-key",
                        "alg": -7
                    }
                ],
                "timeout": 60000,
                "attestation": "none"
            }
            """
                .trimIndent()
        }

        /**
         * Generates the default WebAuthn `PublicKeyCredentialRequestOptionsJSON` payload required by Android Credential
         * Manager's [GetRestoreCredentialOption] API to query for existing restore keys.
         *
         * The Android Credential Manager API strictly requires valid WebAuthn JSON structure to execute key retrieval.
         * The current implementation intentionally generates compliant WebAuthn options locally because restore
         * credentials are being used for account recognition rather than full passkey authentication.
         *
         * Note: When dynamic FxA server WebAuthn endpoints are integrated in the future, server-issued options can
         * override this default payload.
         */
        private fun generateDefaultAuthenticationJson(): String {
            return """
            {
                "rpId": "accounts.firefox.com",
                "challenge": "d2hpY2ggaXMgYSByYW5kb20gY2hhbGxlbmdl",
                "allowCredentials": [],
                "timeout": 60000
            }
            """
                .trimIndent()
        }
    }
}
