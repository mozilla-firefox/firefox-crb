/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.fenix.settings

import android.os.Bundle
import android.view.View
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.navigation.fragment.navArgs
import androidx.preference.Preference
import androidx.preference.PreferenceCategory
import androidx.preference.PreferenceFragmentCompat
import androidx.preference.SwitchPreferenceCompat
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch
import mozilla.telemetry.glean.private.NoExtras
import org.mozilla.fenix.GleanMetrics.Events
import org.mozilla.fenix.GleanMetrics.Tabs
import org.mozilla.fenix.R
import org.mozilla.fenix.e2e.SystemInsetsPaddedFragment
import org.mozilla.fenix.ext.requireComponents
import org.mozilla.fenix.ext.showToolbar
import org.mozilla.fenix.utils.view.addToRadioGroup

/** Lets the user customize auto closing tabs. */
class TabsSettingsFragment : PreferenceFragmentCompat(), SystemInsetsPaddedFragment {
    private lateinit var listRadioButton: RadioButtonPreference
    private lateinit var gridRadioButton: RadioButtonPreference
    private lateinit var radioManual: RadioButtonPreference
    private lateinit var radioOneDay: RadioButtonPreference
    private lateinit var radioOneWeek: RadioButtonPreference
    private lateinit var radioOneMonth: RadioButtonPreference
    private lateinit var inactiveTabs: SwitchPreferenceCompat
    private lateinit var privacyReport: SwitchPreferenceCompat
    private lateinit var tabGroups: SwitchPreferenceCompat
    private lateinit var tabOrganizationCategory: PreferenceCategory
    private val args by navArgs<TabsSettingsFragmentArgs>()

    override fun onCreatePreferences(savedInstanceState: Bundle?, rootKey: String?) {
        setPreferencesFromResource(R.xml.tabs_preferences, rootKey)
        setupPreferences()
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        Tabs.settingOpened.record(NoExtras())
        observeTabSettings()
    }

    override fun onResume() {
        super.onResume()
        showToolbar(getString(R.string.preferences_tabs))

        args.preferenceToScrollTo?.let {
            scrollToPreferenceWithHighlight(it)
        }
    }

    /**
     * Keeps the inactive tabs and tab groups switches in sync with the tab settings, which may still be loading from
     * disk when this screen opens, or may change while it is visible. The switches stay hidden until the settings are
     * known, so they never show a value that is not the user's.
     */
    private fun observeTabSettings() {
        viewLifecycleOwner.lifecycleScope.launch {
            viewLifecycleOwner.repeatOnLifecycle(Lifecycle.State.STARTED) {
                requireComponents.tabDataCoordinator.tabSettings.filterNotNull().collect { settings ->
                    inactiveTabs.isChecked = settings.inactiveTabsEnabled
                    tabGroups.isChecked = settings.tabGroupsEnabled
                    tabOrganizationCategory.isVisible = true
                    inactiveTabs.isVisible = true
                    tabGroups.isVisible = true
                }
            }
        }
    }

    private fun setupPreferences() {
        // This should be the only use case for pref_key_tab_view_list_do_not_use.
        // In the Fenix impl of RadioGroups, we need to always have an individual pref value
        // for it to work. This is weird for a radio group that should hold a value from that group.
        // For the tabs tray, we only need a boolean value, so let's rely on only the
        // pref_key_tab_view_grid and look into using the native RadioGroup in the future.
        listRadioButton = requirePreference(R.string.pref_key_tab_view_list_do_not_use)
        gridRadioButton = requirePreference(R.string.pref_key_tab_view_grid)

        radioManual = requirePreference(R.string.pref_key_close_tabs_manually)
        radioOneMonth = requirePreference(R.string.pref_key_close_tabs_after_one_month)
        radioOneWeek = requirePreference(R.string.pref_key_close_tabs_after_one_week)
        radioOneDay = requirePreference(R.string.pref_key_close_tabs_after_one_day)

        val settings = requireComponents.settings
        val tabDataCoordinator = requireComponents.tabDataCoordinator

        tabOrganizationCategory = requirePreference(R.string.pref_key_tab_organization)
        tabOrganizationCategory.isVisible = false

        inactiveTabs =
            requirePreference<SwitchPreferenceCompat>(R.string.pref_key_inactive_tabs).also {
                // Hide the setting in code instead of the XML so it's visible to the settings indexer
                it.isVisible = false
                it.isEnabled = !(settings.closeTabsAfterOneDay || settings.closeTabsAfterOneWeek)
                it.onPreferenceChangeListener = onTabSettingToggled(tabDataCoordinator::setInactiveTabsEnabled)
            }

        privacyReport =
            requirePreference<SwitchPreferenceCompat>(R.string.pref_key_privacy_report_tab_manager).also {
                it.isChecked = settings.showPrivacyReportInTabManager
                it.onPreferenceChangeListener = SharedPreferenceUpdater()
            }

        tabGroups =
            requirePreference<SwitchPreferenceCompat>(R.string.pref_key_tab_groups).also {
                // Hide the setting in code instead of the XML so it's visible to the settings indexer
                it.isVisible = false
                it.onPreferenceChangeListener = onTabSettingToggled(tabDataCoordinator::setTabGroupsEnabled)
            }

        listRadioButton.onClickListener(::sendTabViewTelemetry)
        gridRadioButton.onClickListener(::sendTabViewTelemetry)

        radioManual.onClickListener(::enableInactiveTabsSetting)
        radioOneDay.onClickListener(::disableInactiveTabsSetting)
        radioOneWeek.onClickListener(::disableInactiveTabsSetting)
        radioOneMonth.onClickListener(::enableInactiveTabsSetting)

        setupRadioGroups()
    }

    private fun setupRadioGroups() {
        addToRadioGroup(
            listRadioButton,
            gridRadioButton,
        )

        addToRadioGroup(
            radioManual,
            radioOneDay,
            radioOneMonth,
            radioOneWeek,
        )
    }

    private fun sendTabViewTelemetry() {
        if (listRadioButton.isChecked && !gridRadioButton.isChecked) {
            Events.tabViewChanged.record(Events.TabViewChangedExtra("list"))
        } else {
            Events.tabViewChanged.record(Events.TabViewChangedExtra("grid"))
        }
    }

    private fun enableInactiveTabsSetting() {
        inactiveTabs.isEnabled = true
    }

    private fun disableInactiveTabsSetting() {
        inactiveTabs.isEnabled = false
        inactiveTabs.isChecked = false
        requireComponents.tabDataCoordinator.setInactiveTabsEnabled(false)
    }

    /**
     * Returns a listener that forwards a switch toggle to [setTabSetting], which writes it to the tab settings owned by
     * the Tab Data Coordinator instead of SharedPreferences.
     */
    private fun onTabSettingToggled(setTabSetting: (enabled: Boolean) -> Unit) =
        Preference.OnPreferenceChangeListener { _, newValue ->
            val enabled = newValue as? Boolean
            if (enabled != null) {
                setTabSetting(enabled)
                true
            } else {
                false
            }
        }
}
