/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.settings

import android.os.Looper
import androidx.appcompat.app.AppCompatActivity
import androidx.preference.Preference
import androidx.preference.SwitchPreferenceCompat
import io.mockk.every
import io.mockk.mockk
import mozilla.components.feature.tab.settings.data.TabSettings
import mozilla.components.feature.tabdata.coordinator.fakes.FakeTabDataCoordinator
import mozilla.components.support.test.robolectric.testContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.mozilla.fenix.R
import org.mozilla.fenix.ext.components
import org.mozilla.fenix.helpers.FenixGleanTestRule
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class TabsSettingsFragmentTest {

    @get:Rule val gleanTestRule = FenixGleanTestRule(testContext)

    private lateinit var fragment: TabsSettingsFragment

    @Test
    fun `GIVEN the tab settings have not loaded WHEN the screen is shown THEN the tab organization settings are hidden`() {
        launchFragment(tabDataCoordinator = FakeTabDataCoordinator(initialTabSettings = null))

        assertFalse(tabOrganizationCategory().isVisible)
        assertFalse(inactiveTabsSwitch().isVisible)
        assertFalse(tabGroupsSwitch().isVisible)
    }

    @Test
    fun `GIVEN the tab settings have loaded WHEN the screen is shown THEN the tab organization settings show the persisted values`() {
        launchFragment(
            tabDataCoordinator =
                FakeTabDataCoordinator(
                    initialTabSettings = TabSettings(tabGroupsEnabled = false, inactiveTabsEnabled = true)
                )
        )

        assertTrue(tabOrganizationCategory().isVisible)
        assertTrue(inactiveTabsSwitch().isVisible)
        assertTrue(tabGroupsSwitch().isVisible)
        assertTrue(inactiveTabsSwitch().isChecked)
        assertFalse(tabGroupsSwitch().isChecked)
    }

    @Test
    fun `GIVEN the tab settings have not loaded WHEN they load THEN the tab organization settings are shown with the loaded values`() {
        val tabDataCoordinator = FakeTabDataCoordinator(initialTabSettings = null)
        launchFragment(tabDataCoordinator = tabDataCoordinator)

        tabDataCoordinator.tabSettings.value = TabSettings(tabGroupsEnabled = true, inactiveTabsEnabled = false)
        shadowOf(Looper.getMainLooper()).idle()

        assertTrue(tabOrganizationCategory().isVisible)
        assertTrue(inactiveTabsSwitch().isVisible)
        assertTrue(tabGroupsSwitch().isVisible)
        assertFalse(inactiveTabsSwitch().isChecked)
        assertTrue(tabGroupsSwitch().isChecked)
    }

    @Test
    fun `WHEN the tab settings change while the screen is shown THEN the switches are updated`() {
        val tabDataCoordinator =
            FakeTabDataCoordinator(
                initialTabSettings = TabSettings(tabGroupsEnabled = true, inactiveTabsEnabled = true)
            )
        launchFragment(tabDataCoordinator = tabDataCoordinator)

        tabDataCoordinator.tabSettings.value = TabSettings(tabGroupsEnabled = false, inactiveTabsEnabled = false)
        shadowOf(Looper.getMainLooper()).idle()

        assertFalse(inactiveTabsSwitch().isChecked)
        assertFalse(tabGroupsSwitch().isChecked)
    }

    @Test
    fun `WHEN the tab groups switch is toggled THEN the setting is written to the tab data coordinator`() {
        val tabDataCoordinator =
            FakeTabDataCoordinator(
                initialTabSettings = TabSettings(tabGroupsEnabled = true, inactiveTabsEnabled = true)
            )
        launchFragment(tabDataCoordinator = tabDataCoordinator)

        val accepted = tabGroupsSwitch().callChangeListener(false)

        assertTrue(accepted)
        assertEquals(false, tabDataCoordinator.tabSettings.value?.tabGroupsEnabled)
        assertEquals(true, tabDataCoordinator.tabSettings.value?.inactiveTabsEnabled)
    }

    @Test
    fun `WHEN the inactive tabs switch is toggled THEN the setting is written to the tab data coordinator`() {
        val tabDataCoordinator =
            FakeTabDataCoordinator(
                initialTabSettings = TabSettings(tabGroupsEnabled = true, inactiveTabsEnabled = true)
            )
        launchFragment(tabDataCoordinator = tabDataCoordinator)

        val accepted = inactiveTabsSwitch().callChangeListener(false)

        assertTrue(accepted)
        assertEquals(false, tabDataCoordinator.tabSettings.value?.inactiveTabsEnabled)
        assertEquals(true, tabDataCoordinator.tabSettings.value?.tabGroupsEnabled)
    }

    @Test
    fun `WHEN a tab organization switch reports a non-boolean value THEN the change is rejected`() {
        val tabDataCoordinator =
            FakeTabDataCoordinator(
                initialTabSettings = TabSettings(tabGroupsEnabled = true, inactiveTabsEnabled = true)
            )
        launchFragment(tabDataCoordinator = tabDataCoordinator)

        val accepted = tabGroupsSwitch().callChangeListener("not a boolean")

        assertFalse(accepted)
        assertEquals(true, tabDataCoordinator.tabSettings.value?.tabGroupsEnabled)
    }

    private fun launchFragment(tabDataCoordinator: FakeTabDataCoordinator) {
        every { testContext.components.settings } returns mockk(relaxed = true)
        every { testContext.components.tabDataCoordinator } returns tabDataCoordinator

        val controller = Robolectric.buildActivity(AppCompatActivity::class.java)
        controller.get().setTheme(R.style.NormalTheme)
        val activity = controller.setup().get()

        fragment = TabsSettingsFragment().apply { arguments = TabsSettingsFragmentArgs().toBundle() }
        activity.supportFragmentManager.beginTransaction().add(fragment, "TabsSettingsFragmentTest").commitNow()
        shadowOf(Looper.getMainLooper()).idle()
    }

    private fun tabOrganizationCategory(): Preference = fragment.requirePreference(R.string.pref_key_tab_organization)

    private fun inactiveTabsSwitch(): SwitchPreferenceCompat =
        fragment.requirePreference(R.string.pref_key_inactive_tabs)

    private fun tabGroupsSwitch(): SwitchPreferenceCompat = fragment.requirePreference(R.string.pref_key_tab_groups)
}
