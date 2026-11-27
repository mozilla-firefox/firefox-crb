/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/Utf8.h"

#include <string.h>

#include "js/CompilationAndEvaluation.h"
#include "js/ProfilingSources.h"
#include "js/ProfilingStack.h"
#include "js/SourceText.h"
#include "jsapi-tests/tests.h"

static ProfilingStack sourcesProfilingStack;

static bool EvaluateWithFilename(JSContext* cx, const char* aFilename,
                                 const char* aSource) {
  JS::CompileOptions options(cx);
  options.setFileAndLine(aFilename, 1);
  JS::SourceText<mozilla::Utf8Unit> srcBuf;
  if (!srcBuf.init(cx, aSource, strlen(aSource),
                   JS::SourceOwnership::Borrowed)) {
    return false;
  }
  JS::RootedValue rval(cx);
  return JS::Evaluate(cx, options, srcBuf, &rval);
}

static bool HasFilename(const ProfilerJSSourceData& aSource,
                        const char* aFilename) {
  return aSource.filePathLength() == strlen(aFilename) &&
         memcmp(aSource.filePath(), aFilename, aSource.filePathLength()) == 0;
}

BEGIN_TEST(testProfilerScriptSources_copiesSameSourceOnce) {
  js::SetContextProfilingStack(cx, &sourcesProfilingStack);
  js::EnableContextProfilingStack(cx, true);

  const char* source = "function f() { return 1; } f();";
  CHECK(EvaluateWithFilename(cx, "same.js", source));
  CHECK(EvaluateWithFilename(cx, "same.js", source));
  CHECK(EvaluateWithFilename(cx, "other.js", source));
  CHECK(EvaluateWithFilename(cx, "same.js", "function g() { return 2; } g();"));

  js::ProfilerJSSources sources =
      js::GetProfilerScriptSources(cx->runtime(), /* gatherSourceText */ true);

  size_t sameJSWithText = 0;
  size_t aliases = 0;
  for (const ProfilerJSSourceData& sourceData : sources) {
    if (auto index = sourceData.sameSourceAsIndex()) {
      aliases++;
      CHECK(*index < sources.length());
      const ProfilerJSSourceData& target = sources[*index];
      CHECK(!target.sameSourceAsIndex());
      CHECK(target.sourceId() != sourceData.sourceId());
      CHECK(HasFilename(target, "same.js"));
      CHECK(target.data().is<ProfilerJSSourceData::SourceTextUTF8>());
      const auto& text =
          target.data().as<ProfilerJSSourceData::SourceTextUTF8>();
      CHECK(text.length() == strlen(source));
      CHECK(memcmp(text.chars().get(), source, text.length()) == 0);
      CHECK(sourceData.data().is<ProfilerJSSourceData::Unavailable>());
    } else if (HasFilename(sourceData, "same.js")) {
      sameJSWithText++;
    }
  }
  // The two same.js sources with the same text share one copy; other.js and
  // the same.js source with other text get their own.
  CHECK(aliases == 1);
  CHECK(sameJSWithText == 2);

  // Without source text there is nothing to share.
  js::ProfilerJSSources metadataOnly =
      js::GetProfilerScriptSources(cx->runtime(), /* gatherSourceText */ false);
  CHECK(metadataOnly.length() == sources.length());
  for (const ProfilerJSSourceData& sourceData : metadataOnly) {
    CHECK(!sourceData.sameSourceAsIndex());
  }

  js::EnableContextProfilingStack(cx, false);
  return true;
}
END_TEST(testProfilerScriptSources_copiesSameSourceOnce)
