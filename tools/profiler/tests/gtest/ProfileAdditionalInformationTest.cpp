/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "gtest/gtest.h"
#include "js/Utility.h"
#include "ProfileAdditionalInformation.h"

#include <string>

using mozilla::JSSourceEntry;
using mozilla::ProfileGenerationAdditionalInformation;

namespace {

JS::UniqueChars CopyChars(const std::string& aString) {
  JS::UniqueChars chars(js_pod_malloc<char>(aString.size() + 1));
  memcpy(chars.get(), aString.c_str(), aString.size() + 1);
  return chars;
}

JS::UniqueTwoByteChars CopyTwoByteChars(const std::u16string& aString) {
  JS::UniqueTwoByteChars chars(js_pod_malloc<char16_t>(aString.size() + 1));
  memcpy(chars.get(), aString.c_str(), (aString.size() + 1) * sizeof(char16_t));
  return chars;
}

JSSourceEntry UTF8Entry(const char* aId, uint32_t aSourceId,
                        const std::string& aText,
                        const std::u16string& aSourceMapURL = u"") {
  std::string path = std::string("https://example.com/") + aId + ".js";
  return JSSourceEntry(
      nsCString(aId),
      ProfilerJSSourceData(
          aSourceId, CopyChars(aText), aText.size(), CopyChars(path),
          path.size(), 1, 1,
          aSourceMapURL.empty() ? nullptr : CopyTwoByteChars(aSourceMapURL),
          aSourceMapURL.size()));
}

JSSourceEntry UnavailableEntry(const char* aId, uint32_t aSourceId) {
  std::string path = std::string("https://example.com/") + aId + ".js";
  return JSSourceEntry(
      nsCString(aId),
      ProfilerJSSourceData(aSourceId, CopyChars(path), path.size(), 1, 1,
                           JS::UniqueTwoByteChars(), 0));
}

ProfileGenerationAdditionalInformation MakeInfo(
    nsTArray<JSSourceEntry>&& aEntries) {
  return ProfileGenerationAdditionalInformation(SharedLibraryInfo(),
                                                std::move(aEntries));
}

}  // namespace

TEST(ProfileAdditionalInformation, DeduplicatesById)
{
  nsTArray<JSSourceEntry> entries;
  entries.AppendElement(UTF8Entry("a", 1, "one"));
  entries.AppendElement(UTF8Entry("b", 2, "two"));
  entries.AppendElement(UTF8Entry("a", 3, "one"));
  auto info = MakeInfo(std::move(entries));

  info.DeduplicateJSSourceEntries();

  const auto& result = info.JSSourceEntries();
  ASSERT_EQ(result.Length(), 2u);
  EXPECT_TRUE(result[0].id.EqualsLiteral("a"));
  EXPECT_EQ(result[0].sourceData.sourceId(), 1u);
  EXPECT_TRUE(result[1].id.EqualsLiteral("b"));
}

TEST(ProfileAdditionalInformation, PrefersAvailableSourceData)
{
  nsTArray<JSSourceEntry> entries;
  entries.AppendElement(UnavailableEntry("a", 1));
  entries.AppendElement(UTF8Entry("a", 2, "one", u"a.js.map"));
  entries.AppendElement(UTF8Entry("b", 3, "two"));
  entries.AppendElement(UTF8Entry("c", 4, "three"));
  entries.AppendElement(UnavailableEntry("c", 5));
  auto info = MakeInfo(std::move(entries));

  info.DeduplicateJSSourceEntries();

  const auto& result = info.JSSourceEntries();
  ASSERT_EQ(result.Length(), 3u);
  EXPECT_EQ(result[0].sourceData.sourceId(), 2u);
  ASSERT_TRUE(
      result[0].sourceData.data().is<ProfilerJSSourceData::SourceTextUTF8>());
  const auto& text =
      result[0].sourceData.data().as<ProfilerJSSourceData::SourceTextUTF8>();
  EXPECT_EQ(std::string(text.chars().get(), text.length()), "one");
  EXPECT_EQ(std::u16string(result[0].sourceData.sourceMapURL(),
                           result[0].sourceData.sourceMapURLLength()),
            u"a.js.map");
  EXPECT_EQ(result[1].sourceData.sourceId(), 3u);
  EXPECT_EQ(result[2].sourceData.sourceId(), 4u);
  EXPECT_TRUE(
      result[2].sourceData.data().is<ProfilerJSSourceData::SourceTextUTF8>());
}
