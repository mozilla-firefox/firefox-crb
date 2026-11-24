/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.components

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import mozilla.components.feature.tab.settings.migration.LegacyTabSettings
import org.mozilla.fenix.R
import org.mozilla.fenix.ext.getPreferenceKey

/**
 * The tab settings formerly persisted in Fenix's [SharedPreferences], exposed so they can be migrated to the tab
 * settings data store.
 *
 * @param context [Context] used to resolve the preference keys.
 * @param preferences The [SharedPreferences] the settings were persisted in.
 */
class SharedPreferencesLegacyTabSettings(
    context: Context,
    private val preferences: SharedPreferences,
) : LegacyTabSettings {

    private val tabGroupsEnabledKey = context.getPreferenceKey(R.string.pref_key_tab_groups)
    private val inactiveTabsEnabledKey = context.getPreferenceKey(R.string.pref_key_inactive_tabs)

    override fun tabGroupsEnabled(): Boolean? = preferences.booleanOrNull(tabGroupsEnabledKey)

    override fun inactiveTabsEnabled(): Boolean? = preferences.booleanOrNull(inactiveTabsEnabledKey)

    override fun clear() {
        preferences.edit {
            remove(tabGroupsEnabledKey)
            remove(inactiveTabsEnabledKey)
        }
    }

    private fun SharedPreferences.booleanOrNull(key: String): Boolean? =
        if (contains(key)) getBoolean(key, false) else null
}
