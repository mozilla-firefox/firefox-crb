# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os
import sys

# add this directory to the path
sys.path.append(os.path.dirname(__file__))

from session_store_test_case import SessionStoreTestCase, inline

TEST_WINDOWS = set([
    (inline("<div>one</div>"),),
    (inline("<div>two</div>"),),
    (inline("<div>three</div>"),),
    (inline("<div>four</div>"),),
])


class TestRestoreWindowsClosedInSeries(SessionStoreTestCase):
    """
    Bug 1818971 - Closing every window one after the other, as the OS taskbar's
    "Close all windows" does, should restore all of those windows at the next
    startup, regardless of browser.sessionstore.max_windows_undo.
    """

    startup_prefs = {"browser.sessionstore.max_windows_undo": 2}

    def setUp(self):
        super().setUp(
            startup_page=3,
            include_private=False,
            test_windows=TEST_WINDOWS,
        )
        self.wait_for_windows(
            self.all_windows, "Not all requested windows have been opened"
        )
        self.flush_all_windows()

    def flush_all_windows(self, save=False):
        self.marionette.execute_async_script(
            """
            let [save, resolve] = arguments;
            const { TabStateFlusher } = ChromeUtils.importESModule(
                "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs"
            );
            const { SessionSaver } = ChromeUtils.importESModule(
                "moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs"
            );
            (async () => {
                for (let win of Services.wm.getEnumerator("navigator:browser")) {
                    await TabStateFlusher.flushWindow(win);
                }
                if (save) {
                    await SessionSaver.run();
                }
            })().then(resolve);
            """,
            script_args=[save],
        )

    def close_window(self, handle):
        urls = tuple(self.get_urls_for_window(handle))
        self.marionette.switch_to_window(handle)
        self.marionette.close_chrome_window()
        self.marionette.switch_to_window(self.marionette.chrome_window_handles[0])
        return urls

    def close_remaining_windows_and_restart(self):
        handles = self.marionette.chrome_window_handles
        for handle in handles[:-1]:
            self.close_window(handle)
        self.marionette.switch_to_window(handles[-1])
        self.marionette.quit(callback=self._close_window)
        self.marionette.start_session()
        self.marionette.set_context("chrome")

    def assert_restored_windows(self, expected_windows, message):
        self.wait_for_windows(expected_windows, message)
        # wait_for_windows compares sets, so it can't tell when a window has
        # been restored more than once.
        self.assertEqual(
            len(self.marionette.chrome_window_handles),
            len(expected_windows),
            msg="No window should have been restored more than once",
        )

    def test_more_windows_than_max_windows_undo(self):
        self.close_remaining_windows_and_restart()

        self.assert_restored_windows(
            self.all_windows,
            "All windows closed in series should have been restored",
        )

    def test_window_closed_before_the_series(self):
        closed_urls = self.close_window(self.marionette.chrome_window_handles[0])
        # Opening a tab shows the browser is still in use, so the window
        # closed above is not part of the series of windows closing to quit.
        self.marionette.execute_script(
            """
            let tab = gBrowser.addTrustedTab("about:blank");
            gBrowser.removeTab(tab);
            """
        )
        self.flush_all_windows()

        self.close_remaining_windows_and_restart()

        self.assert_restored_windows(
            self.all_windows - {closed_urls},
            "Only the windows closed in series should have been restored",
        )

    def test_new_tab_preloaded_during_the_series(self):
        self.close_window(self.marionette.chrome_window_handles[0])
        # Creating a preloaded new tab browser fires XULFrameLoaderCreated,
        # which isn't an interaction with the browser.
        preloaded = self.marionette.execute_script(
            """
            NewTabPagePreloading.removePreloadedBrowser(window);
            NewTabPagePreloading.maybeCreatePreloadedBrowser(window);
            return !!gBrowser.preloadedBrowser;
            """
        )
        self.assertTrue(preloaded, msg="A preloaded browser should have been created")

        self.close_remaining_windows_and_restart()

        self.assert_restored_windows(
            self.all_windows,
            "All windows closed in series should have been restored",
        )

    def test_session_saved_during_the_series(self):
        self.close_window(self.marionette.chrome_window_handles[0])
        self.flush_all_windows(save=True)

        self.close_remaining_windows_and_restart()

        self.assert_restored_windows(
            self.all_windows,
            "All windows closed in series should have been restored",
        )
