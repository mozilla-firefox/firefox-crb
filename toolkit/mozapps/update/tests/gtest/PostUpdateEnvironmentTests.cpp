/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "gtest/gtest.h"
#include "PostUpdateEnvironment.h"

#include "mozilla/ScopeExit.h"
#include "nsWindowsHelpers.h"

#include <cwchar>
#include <iterator>
#include <string>
#include <string_view>
#include <vector>
#include <windows.h>
#include <userenv.h>

namespace {

constexpr WCHAR kMarkerName[]{L"POST_UPDATE_ENVIRONMENT_TEST_MARKER"};

std::vector<std::wstring> ReadEntries(LPVOID aBlock) {
  std::vector<std::wstring> entries;
  LPCWSTR cursor{static_cast<LPCWSTR>(aBlock)};
  while (*cursor) {
    entries.emplace_back(cursor);
    cursor += entries.back().size() + 1;
  }
  return entries;
}

std::wstring_view FindVariable(const std::vector<std::wstring>& aEntries,
                               std::wstring_view aName) {
  for (const std::wstring& entry : aEntries) {
    if (entry.size() > aName.size() && entry[aName.size()] == L'=' &&
        _wcsnicmp(entry.c_str(), aName.data(), aName.size()) == 0) {
      return entry;
    }
  }
  return {};
}

std::vector<std::wstring> SystemEntries() {
  WCHAR windowsDirectory[MAX_PATH + 1];
  UINT length =
      GetSystemWindowsDirectoryW(windowsDirectory, std::size(windowsDirectory));
  EXPECT_GT(length, 2u);
  EXPECT_LT(length, std::size(windowsDirectory));
  std::wstring systemRoot{windowsDirectory, length};
  return {L"SystemDrive=" + systemRoot.substr(0, 2),
          L"SystemRoot=" + systemRoot};
}

}  // namespace

class PostUpdateEnvironmentTest : public ::testing::Test {
 protected:
  void SetUp() override {
    ASSERT_TRUE(SetEnvironmentVariableW(kMarkerName, L"1"));
  }

  void TearDown() override { SetEnvironmentVariableW(kMarkerName, nullptr); }
};

TEST_F(PostUpdateEnvironmentTest,
       UnelevatedUsesOnlySystemAndDefaultTempDirectories) {
  HANDLE rawToken = nullptr;
  ASSERT_TRUE(OpenProcessToken(GetCurrentProcess(),
                               TOKEN_QUERY | TOKEN_DUPLICATE, &rawToken));
  nsAutoHandle token{rawToken};
  LPVOID environmentBlock = nullptr;
  ASSERT_TRUE(CreateEnvironmentBlock(&environmentBlock, token, FALSE));
  auto freeEnvironment = mozilla::MakeScopeExit(
      [&] { DestroyEnvironmentBlock(environmentBlock); });
  auto defaultEntries = ReadEntries(environmentBlock);

  auto* inheritedEnvironment = GetEnvironmentStringsW();
  ASSERT_NE(inheritedEnvironment, nullptr);
  auto freeInheritedEnvironment = mozilla::MakeScopeExit(
      [&] { FreeEnvironmentStringsW(inheritedEnvironment); });
  auto inheritedEntries = ReadEntries(inheritedEnvironment);
  auto restoreEnvironment = mozilla::MakeScopeExit([&] {
    for (const auto* name : {L"TEMP", L"TMP", L"USERPROFILE"}) {
      auto entry = FindVariable(inheritedEntries, name);
      EXPECT_TRUE(SetEnvironmentVariableW(
          name, entry.empty() ? nullptr : entry.data() + wcslen(name) + 1));
    }
  });

  std::vector<std::wstring> expectedEntries{SystemEntries()};
  for (const auto* name : {L"TEMP", L"TMP", L"USERPROFILE"}) {
    auto entry = FindVariable(defaultEntries, name);
    std::wstring conflictingValue = L"C:\\post update \u00fc\\";
    if (!entry.empty()) {
      expectedEntries.emplace_back(entry);
      conflictingValue.assign(entry.substr(wcslen(name) + 1));
    }
    conflictingValue.append(L"\\inherited \u00fc ").append(name);
    ASSERT_TRUE(SetEnvironmentVariableW(name, conflictingValue.c_str()));
  }

  PostUpdateEnvironment postUpdateEnvironment{ElevationType::None};
  ASSERT_NE(postUpdateEnvironment.get(), nullptr);

  std::vector<std::wstring> entries{ReadEntries(postUpdateEnvironment.get())};
  EXPECT_FALSE(entries.empty());
  EXPECT_FALSE(FindVariable(entries, L"USERPROFILE").empty());
  EXPECT_EQ(entries, expectedEntries);
}

TEST_F(PostUpdateEnvironmentTest, UnelevatedDropsInheritedVariables) {
  PostUpdateEnvironment postUpdateEnvironment{ElevationType::None};
  ASSERT_NE(postUpdateEnvironment.get(), nullptr);

  EXPECT_TRUE(
      FindVariable(ReadEntries(postUpdateEnvironment.get()), kMarkerName)
          .empty());
}

TEST_F(PostUpdateEnvironmentTest, ElevatedByMMSIsEmpty) {
  PostUpdateEnvironment postUpdateEnvironment{ElevationType::ElevatedByMMS};
  ASSERT_NE(postUpdateEnvironment.get(), nullptr);
  EXPECT_TRUE(ReadEntries(postUpdateEnvironment.get()).empty());
}

TEST_F(PostUpdateEnvironmentTest, ElevatedWithoutMMSIsEmpty) {
  PostUpdateEnvironment postUpdateEnvironment{
      ElevationType::ElevatedWithoutMMS};
  ASSERT_NE(postUpdateEnvironment.get(), nullptr);
  EXPECT_TRUE(ReadEntries(postUpdateEnvironment.get()).empty());
}

TEST_F(PostUpdateEnvironmentTest, UnknownIsEmpty) {
  PostUpdateEnvironment postUpdateEnvironment{ElevationType::Unknown};
  ASSERT_NE(postUpdateEnvironment.get(), nullptr);
  EXPECT_TRUE(ReadEntries(postUpdateEnvironment.get()).empty());
}

TEST_F(PostUpdateEnvironmentTest, ErrorIsEmpty) {
  PostUpdateEnvironment postUpdateEnvironment{ElevationType::Error};
  ASSERT_NE(postUpdateEnvironment.get(), nullptr);
  EXPECT_TRUE(ReadEntries(postUpdateEnvironment.get()).empty());
}
