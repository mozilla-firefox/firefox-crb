/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "PostUpdateEnvironment.h"

#include <cwchar>
#include <iterator>
#include <string_view>
#include <userenv.h>

#include "mozilla/ScopeExit.h"

#include "nsWindowsHelpers.h"
#include "updatecommon.h"

namespace {

void AppendVariable(std::wstring& aBlock, std::wstring_view aName,
                    std::wstring_view aValue) {
  aBlock.append(aName).append(1, L'=').append(aValue).append(1, L'\0');
}

void AppendSystemVariables(std::wstring& aBlock) {
  WCHAR windowsDirectory[MAX_PATH + 1];
  UINT length =
      GetSystemWindowsDirectoryW(windowsDirectory, std::size(windowsDirectory));
  if (length < 2 || length >= std::size(windowsDirectory) ||
      windowsDirectory[1] != L':') {
    LOG(
        ("PostUpdateEnvironment::PostUpdateEnvironment - "
         "GetSystemWindowsDirectoryW failed: %lu",
         GetLastError()));
    return;
  }
  AppendVariable(aBlock, L"SystemDrive", {windowsDirectory, 2});
  AppendVariable(aBlock, L"SystemRoot", {windowsDirectory, length});
}

void AppendDefaultUserVariables(std::wstring& aBlock) {
  HANDLE rawToken{nullptr};
  if (!OpenProcessToken(GetCurrentProcess(),
                        TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE,
                        &rawToken)) {
    LOG(
        ("PostUpdateEnvironment::PostUpdateEnvironment - OpenProcessToken "
         "failed: %lu",
         GetLastError()));
    return;
  }
  nsAutoHandle token{rawToken};

  LPVOID environmentBlock = nullptr;
  if (!CreateEnvironmentBlock(&environmentBlock, token, FALSE)) {
    LOG(
        ("PostUpdateEnvironment::PostUpdateEnvironment - "
         "CreateEnvironmentBlock failed: %lu",
         GetLastError()));
    return;
  }
  auto freeEnvironment = mozilla::MakeScopeExit(
      [&] { DestroyEnvironmentBlock(environmentBlock); });

  for (const auto* entry = static_cast<const wchar_t*>(environmentBlock);
       *entry;) {
    size_t length = wcslen(entry) + 1;
    if (_wcsnicmp(entry, L"TEMP=", 5) == 0 ||
        _wcsnicmp(entry, L"TMP=", 4) == 0 ||
        _wcsnicmp(entry, L"USERPROFILE=", 12) == 0) {
      aBlock.append(entry, length);
    }
    entry += length;
  }
}

}  // namespace

PostUpdateEnvironment::PostUpdateEnvironment(ElevationType aElevationType) {
  if (aElevationType != ElevationType::None) {
    return;
  }

  // CreateProcessW requires the variables to be sorted by name.
  AppendSystemVariables(mEnvironmentBlock);
  AppendDefaultUserVariables(mEnvironmentBlock);
}

LPVOID PostUpdateEnvironment::get() const {
  static WCHAR kEmptyEnvironmentBlock[]{L"\0"};

  return mEnvironmentBlock.empty()
             ? kEmptyEnvironmentBlock
             : const_cast<wchar_t*>(mEnvironmentBlock.c_str());
}
