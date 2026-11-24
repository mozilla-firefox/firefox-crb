/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.components

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import mozilla.components.support.test.robolectric.testContext
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.fenix.R
import org.mozilla.fenix.ext.getPreferenceKey

@RunWith(AndroidJUnit4::class)
class SharedPreferencesLegacyTabSettingsTest {

    private lateinit var preferences: SharedPreferences
    private lateinit var legacyTabSettings: SharedPreferencesLegacyTabSettings

    private val tabGroupsEnabledKey = testContext.getPreferenceKey(R.string.pref_key_tab_groups)
    private val inactiveTabsEnabledKey = testContext.getPreferenceKey(R.string.pref_key_inactive_tabs)

    @Before
    fun setup() {
        preferences = testContext.getSharedPreferences("SharedPreferencesLegacyTabSettingsTest", Context.MODE_PRIVATE)
        preferences.edit { clear() }
        legacyTabSettings = SharedPreferencesLegacyTabSettings(context = testContext, preferences = preferences)
    }

    @Test
    fun `GIVEN the settings were never persisted THEN they are null`() {
        assertNull(legacyTabSettings.tabGroupsEnabled())
        assertNull(legacyTabSettings.inactiveTabsEnabled())
        assertFalse(preferences.contains(tabGroupsEnabledKey))
        assertFalse(preferences.contains(inactiveTabsEnabledKey))
    }

    @Test
    fun `GIVEN the settings were persisted THEN their persisted values are returned`() {
        preferences.edit {
            putBoolean(tabGroupsEnabledKey, false)
            putBoolean(inactiveTabsEnabledKey, true)
        }

        assertEquals(false, legacyTabSettings.tabGroupsEnabled())
        assertEquals(true, legacyTabSettings.inactiveTabsEnabled())
        assertTrue(preferences.contains(tabGroupsEnabledKey))
        assertTrue(preferences.contains(inactiveTabsEnabledKey))
    }

    @Test
    fun `WHEN the settings are cleared THEN they are removed from the shared preferences`() {
        preferences.edit {
            putBoolean(tabGroupsEnabledKey, false)
            putBoolean(inactiveTabsEnabledKey, false)
        }

        legacyTabSettings.clear()

        assertNull(legacyTabSettings.tabGroupsEnabled())
        assertNull(legacyTabSettings.inactiveTabsEnabled())
        assertFalse(preferences.contains(tabGroupsEnabledKey))
        assertFalse(preferences.contains(inactiveTabsEnabledKey))
    }
}
