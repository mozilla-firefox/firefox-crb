/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "gtest/gtest.h"
#include "nsAlertsIconListener.h"

static constexpr const char* kSnapName = "firefox";
static constexpr const char* kSnapRemotingName = "firefox_firefox";
static constexpr nsLiteralCString kSnapWebAppEntry =
    "firefox_firefox.webapp-1234"_ns;

static nsCString Hint(const nsACString& aAppId, const char* aSnapName,
                      const char* aDesktopFileName = nullptr,
                      const char* aRemotingName = "firefox") {
  return nsAlertsIconListener::GetDesktopEntryHint(
      aAppId, aSnapName, aDesktopFileName, aRemotingName);
}

TEST(AlertsDesktopEntry, OutsideSnap)
{
  EXPECT_EQ(Hint("org.example.WebApp"_ns, nullptr), "org.example.WebApp"_ns);
  EXPECT_EQ(Hint("firefox_firefox.webapp-1234"_ns, nullptr),
            "firefox_firefox.webapp-1234"_ns);
  EXPECT_EQ(Hint("org.example.WebApp"_ns, nullptr, "org.mozilla.firefox"),
            "org.example.WebApp"_ns);
  EXPECT_EQ(Hint(""_ns, nullptr, "org.mozilla.firefox"),
            "org.mozilla.firefox"_ns);
  EXPECT_EQ(Hint(""_ns, nullptr), "firefox"_ns);
}

TEST(AlertsDesktopEntry, SnapHint)
{
  EXPECT_EQ(Hint(""_ns, kSnapName), "firefox"_ns);
  EXPECT_EQ(Hint(""_ns, kSnapName, nullptr, kSnapRemotingName), "firefox"_ns);
  EXPECT_EQ(Hint(""_ns, kSnapName, "firefox_firefox", kSnapRemotingName),
            "firefox"_ns);
  EXPECT_EQ(Hint(kSnapWebAppEntry, kSnapName), "firefox.webapp-1234"_ns);
  EXPECT_EQ(Hint("org.example.WebApp"_ns, kSnapName), "org.example.WebApp"_ns);
  EXPECT_EQ(Hint("firefoxfoo.webapp-1234"_ns, kSnapName),
            "firefoxfoo.webapp-1234"_ns);
}

TEST(AlertsDesktopEntry, SnapParallelInstance)
{
  EXPECT_EQ(Hint("firefox_2_firefox.webapp-1234"_ns, "firefox_2"),
            "firefox.webapp-1234"_ns);
  EXPECT_EQ(Hint(kSnapWebAppEntry, "firefox_2"), kSnapWebAppEntry);
}
