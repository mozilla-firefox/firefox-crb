/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package mozilla.components.feature.tab.settings.migration

/** Read-only view of tab settings persisted by a previous storage mechanism, used to migrate them on first use. */
interface LegacyTabSettings {

    /** Whether the tab groups feature was enabled, or null if the user never set it. */
    fun tabGroupsEnabled(): Boolean?

    /** Whether the inactive tabs feature was enabled, or null if the user never set it. */
    fun inactiveTabsEnabled(): Boolean?

    /** Removes the legacy settings once they are no longer needed. */
    fun clear()

    /** Implemented by the [android.app.Application] to supply the [LegacyTabSettings] to migrate from. */
    interface Provider {

        /** The legacy settings to migrate, or null if there is nothing to migrate from. */
        val legacyTabSettings: LegacyTabSettings?
    }
}
