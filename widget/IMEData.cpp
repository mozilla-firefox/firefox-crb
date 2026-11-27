/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "IMEData.h"

#include "ContentData.h"
#include "TextEvents.h"
#include "gfxFontUtils.h"
#include "mozilla/Maybe.h"
#include "mozilla/ToString.h"
#include "mozilla/Utf16.h"
#include "mozilla/WritingModes.h"
#include "mozilla/dom/ContentChild.h"
#include "nsIWidget.h"
#include "nsPrintfCString.h"
#include "nsString.h"

#ifdef XP_WIN
#  include <minwindef.h>  // for LONG
#endif

namespace mozilla {

template PrintStringDetail::PrintStringDetail(
    const Maybe<nsString>& aMaybeString, uint32_t aMaxLength);

template <typename StringType>
PrintStringDetail::PrintStringDetail(const Maybe<StringType>& aMaybeString,
                                     uint32_t aMaxLength /* = UINT32_MAX */)
    : PrintStringDetail(aMaybeString.refOr(EmptyString()), aMaxLength) {
  if (aMaybeString.isNothing()) {
    AssignASCII(ToString(aMaybeString).c_str());
  }
}

PrintStringDetail::PrintStringDetail(const nsAString& aString,
                                     uint32_t aMaxLength /* = UINT32_MAX */) {
  if (aString.IsVoid()) {
    Assign("<void>");
    return;
  }
  Assign("\"");
  const uint32_t kFirstHalf =
      aString.Length() <= aMaxLength ? UINT32_MAX : (aMaxLength + 1) / 2;
  const uint32_t kSecondHalf =
      aString.Length() <= aMaxLength ? 0 : aMaxLength / 2;
  for (uint32_t i = 0; i < aString.Length(); i++) {
    if (i > 0) {
      AppendLiteral(" ");
    }
    char32_t ch = aString.CharAt(i);
    if (mozilla::IsHighSurrogate(ch) && i + 1 < aString.Length() &&
        mozilla::IsLowSurrogate(aString.CharAt(i + 1))) {
      ch = mozilla::SurrogateToUCS4(ch, aString.CharAt(i + 1));
    }
    Append(PrintCharData(ch));
    if (i + 1 == kFirstHalf) {
      AppendLiteral(" ...");
      i = aString.Length() - kSecondHalf - 1;
      if (mozilla::IsLowSurrogate(aString.CharAt(i)) &&
          mozilla::IsHighSurrogate(aString.CharAt(i - 1))) {
        if (i - 1 <= kFirstHalf) {
          i++;
        } else {
          i--;
        }
      }
    } else if (!mozilla::IsInBMP(ch)) {
      i++;
    }
  }
  AppendLiteral("\" (Length()=");
  AppendInt(static_cast<uint32_t>(aString.Length()));
  AppendLiteral(")");
}

// static
nsCString PrintStringDetail::PrintCharData(char32_t aChar) {
  switch (aChar) {
    case 0x0000:
      return "NULL (0x0000)"_ns;
    case 0x0008:
      return "BACKSPACE (0x0008)"_ns;
    case 0x0009:
      return "CHARACTER TABULATION (0x0009)"_ns;
    case 0x000A:
      return "LINE FEED (0x000A)"_ns;
    case 0x000B:
      return "LINE TABULATION (0x000B)"_ns;
    case 0x000C:
      return "FORM FEED (0x000C)"_ns;
    case 0x000D:
      return "CARRIAGE RETURN (0x000D)"_ns;
    case 0x0018:
      return "CANCEL (0x0018)"_ns;
    case 0x001B:
      return "ESCAPE (0x001B)"_ns;
    case 0x0020:
      return "SPACE (0x0020)"_ns;
    case 0x007F:
      return "DELETE (0x007F)"_ns;
    case 0x00A0:
      return "NO-BREAK SPACE (0x00A0)"_ns;
    case 0x00AD:
      return "SOFT HYPHEN (0x00AD)"_ns;
    case 0x2000:
      return "EN QUAD (0x2000)"_ns;
    case 0x2001:
      return "EM QUAD (0x2001)"_ns;
    case 0x2002:
      return "EN SPACE (0x2002)"_ns;
    case 0x2003:
      return "EM SPACE (0x2003)"_ns;
    case 0x2004:
      return "THREE-PER-EM SPACE (0x2004)"_ns;
    case 0x2005:
      return "FOUR-PER-EM SPACE (0x2005)"_ns;
    case 0x2006:
      return "SIX-PER-EM SPACE (0x2006)"_ns;
    case 0x2007:
      return "FIGURE SPACE (0x2007)"_ns;
    case 0x2008:
      return "PUNCTUATION SPACE (0x2008)"_ns;
    case 0x2009:
      return "THIN SPACE (0x2009)"_ns;
    case 0x200A:
      return "HAIR SPACE (0x200A)"_ns;
    case 0x200B:
      return "ZERO WIDTH SPACE (0x200B)"_ns;
    case 0x200C:
      return "ZERO WIDTH NON-JOINER (0x200C)"_ns;
    case 0x200D:
      return "ZERO WIDTH JOINER (0x200D)"_ns;
    case 0x200E:
      return "LEFT-TO-RIGHT MARK (0x200E)"_ns;
    case 0x200F:
      return "RIGHT-TO-LEFT MARK (0x200F)"_ns;
    case 0x2029:
      return "PARAGRAPH SEPARATOR (0x2029)"_ns;
    case 0x202A:
      return "LEFT-TO-RIGHT EMBEDDING (0x202A)"_ns;
    case 0x202B:
      return "RIGHT-TO-LEFT EMBEDDING (0x202B)"_ns;
    case 0x202D:
      return "LEFT-TO-RIGHT OVERRIDE (0x202D)"_ns;
    case 0x202E:
      return "RIGHT-TO-LEFT OVERRIDE (0x202E)"_ns;
    case 0x202F:
      return "NARROW NO-BREAK SPACE (0x202F)"_ns;
    case 0x205F:
      return "MEDIUM MATHEMATICAL SPACE (0x205F)"_ns;
    case 0x2060:
      return "WORD JOINER (0x2060)"_ns;
    case 0x2066:
      return "LEFT-TO-RIGHT ISOLATE (0x2066)"_ns;
    case 0x2067:
      return "RIGHT-TO-LEFT ISOLATE (0x2067)"_ns;
    case 0x3000:
      return "IDEOGRAPHIC SPACE (0x3000)"_ns;
    case 0xFEFF:
      return "ZERO WIDTH NO-BREAK SPACE (0xFEFF)"_ns;
    default: {
      if (aChar < ' ' || (aChar >= 0x80 && aChar < 0xA0)) {
        return nsPrintfCString("Control (0x%04X)", aChar);
      }
      if (mozilla::IsHighSurrogate(aChar)) {
        return nsPrintfCString("High Surrogate (0x%04X)", aChar);
      }
      if (mozilla::IsLowSurrogate(aChar)) {
        return nsPrintfCString("Low Surrogate (0x%04X)", aChar);
      }
      if (gfxFontUtils::IsVarSelector(aChar)) {
        return mozilla::IsInBMP(aChar)
                   ? nsPrintfCString("Variant Selector (0x%04X)", aChar)
                   : nsPrintfCString("Variant Selector (0x%08X)", aChar);
      }
      nsAutoString utf16Str;
      AppendUCS4ToUTF16(aChar, utf16Str);
      return mozilla::IsInBMP(aChar)
                 ? nsPrintfCString("'%s' (0x%04X)",
                                   NS_ConvertUTF16toUTF8(utf16Str).get(), aChar)
                 : nsPrintfCString("'%s' (0x%08X)",
                                   NS_ConvertUTF16toUTF8(utf16Str).get(),
                                   aChar);
    }
  }
}

std::string format_as(const PrintStringDetail& aDetails) {
  return std::string(aDetails.get());
}

std::ostream& operator<<(std::ostream& aStream,
                         const PrintStringDetail& aDetails) {
  return aStream << format_as(aDetails);
}

template <typename IntType>
std::string format_as(const OffsetAndData<IntType>& aOffsetAndData) {
  const auto maxDataLength =
      aOffsetAndData.mFor == OffsetAndDataFor::CompositionString
          ? PrintStringDetail::kMaxLengthForCompositionString
          : (aOffsetAndData.mFor == OffsetAndDataFor::SelectedString
                 ? PrintStringDetail::kMaxLengthForSelectedString
                 : PrintStringDetail::kMaxLengthForEditor);
  return fmt::format(
      "{{ mOffset={}, mData={}, Length()={}, EndOffset()={} }}",
      aOffsetAndData.mOffset,
      PrintStringDetail(aOffsetAndData.mData, maxDataLength).get(),
      aOffsetAndData.Length(), aOffsetAndData.EndOffset());
}

template std::string format_as(const OffsetAndData<uint32_t>&);
#ifdef XP_WIN
template std::string format_as(const OffsetAndData<LONG>&);
#endif

template <typename IntType>
std::string format_as(const StartAndEndOffsets<IntType>& aStartAndEndOffsets) {
  return fmt::format("{{ mStartOffset={}, mEndOffset={}, Length()={} }}",
                     aStartAndEndOffsets.mStartOffset,
                     aStartAndEndOffsets.mEndOffset,
                     aStartAndEndOffsets.Length());
}

template std::string format_as(const StartAndEndOffsets<uint32_t>&);
#ifdef XP_WIN
template std::string format_as(const StartAndEndOffsets<LONG>&);
#endif

namespace widget {

std::ostream& operator<<(std::ostream& aStream, const IMEEnabled& aEnabled) {
  switch (aEnabled) {
    case IMEEnabled::Disabled:
      return aStream << "DISABLED";
    case IMEEnabled::Enabled:
      return aStream << "ENABLED";
    case IMEEnabled::Password:
      return aStream << "PASSWORD";
    case IMEEnabled::Unknown:
      return aStream << "illegal value";
  }
  MOZ_ASSERT_UNREACHABLE("Add a case to handle your new IMEEnabled value");
  return aStream;
}

std::ostream& operator<<(std::ostream& aStream, const IMEState::Open& aOpen) {
  switch (aOpen) {
    case IMEState::DONT_CHANGE_OPEN_STATE:
      aStream << "DONT_CHANGE_OPEN_STATE";
      break;
    case IMEState::OPEN:
      aStream << "OPEN";
      break;
    case IMEState::CLOSED:
      aStream << "CLOSED";
      break;
    default:
      aStream << "illegal value";
      break;
  }
  return aStream;
}

std::ostream& operator<<(std::ostream& aStream, const IMEState& aState) {
  aStream << "{ mEnabled=" << aState.mEnabled << ", mOpen=" << aState.mOpen
          << " }";
  return aStream;
}

std::ostream& operator<<(std::ostream& aStream,
                         const InputContext::Origin& aOrigin) {
  switch (aOrigin) {
    case InputContext::ORIGIN_MAIN:
      aStream << "ORIGIN_MAIN";
      break;
    case InputContext::ORIGIN_CONTENT:
      aStream << "ORIGIN_CONTENT";
      break;
    default:
      aStream << "illegal value";
      break;
  }
  return aStream;
}

bool InputContext::HasSameURI(nsIURI* aURI) const {
  if (mURI == aURI) {
    return true;
  }
  if (!mURI || !aURI) {
    return false;
  }
  bool same = false;
  return NS_SUCCEEDED(mURI->Equals(aURI, &same)) && same;
}

bool InputContext::Equals(const InputContext& aOther) const {
  if (mIMEState.mEnabled != aOther.mIMEState.mEnabled ||
      mOrigin != aOther.mOrigin ||
      mInPrivateBrowsing != aOther.mInPrivateBrowsing ||
      mHasHandledUserInput != aOther.mHasHandledUserInput ||
      !HasSameURI(aOther.mURI) || mHTMLInputType != aOther.mHTMLInputType ||
      mHTMLInputMode != aOther.mHTMLInputMode ||
      mActionHint != aOther.mActionHint ||
      mAutocapitalize != aOther.mAutocapitalize ||
      mAutocorrect != aOther.mAutocorrect) {
    return false;
  }
  return !mIMEState.IsEditable() || mIMEState.mOpen == aOther.mIMEState.mOpen;
}

std::ostream& operator<<(std::ostream& aStream, const InputContext& aContext) {
  aStream << "{ mIMEState=" << aContext.mIMEState
          << ", mOrigin=" << aContext.mOrigin << ", mHTMLInputType=\""
          << aContext.mHTMLInputType << "\", mHTMLInputMode=\""
          << aContext.mHTMLInputMode << "\", mActionHint=\""
          << aContext.mActionHint << "\", mAutocapitalize=\""
          << aContext.mAutocapitalize
          << "\", mAutocorrect=" << (aContext.mAutocorrect ? "true" : "false")
          << ", mIsPrivateBrowsing="
          << (aContext.mInPrivateBrowsing ? "true" : "false") << " }";
  return aStream;
}

std::ostream& operator<<(std::ostream& aStream,
                         const InputContextAction::Cause& aCause) {
  switch (aCause) {
    case InputContextAction::CAUSE_UNKNOWN:
      aStream << "CAUSE_UNKNOWN";
      break;
    case InputContextAction::CAUSE_UNKNOWN_CHROME:
      aStream << "CAUSE_UNKNOWN_CHROME";
      break;
    case InputContextAction::CAUSE_KEY:
      aStream << "CAUSE_KEY";
      break;
    case InputContextAction::CAUSE_MOUSE:
      aStream << "CAUSE_MOUSE";
      break;
    case InputContextAction::CAUSE_TOUCH:
      aStream << "CAUSE_TOUCH";
      break;
    case InputContextAction::CAUSE_LONGPRESS:
      aStream << "CAUSE_LONGPRESS";
      break;
    case InputContextAction::CAUSE_UNKNOWN_DURING_NON_KEYBOARD_INPUT:
      aStream << "CAUSE_UNKNOWN_DURING_NON_KEYBOARD_INPUT";
      break;
    case InputContextAction::CAUSE_UNKNOWN_DURING_KEYBOARD_INPUT:
      aStream << "CAUSE_UNKNOWN_DURING_KEYBOARD_INPUT";
      break;
    default:
      aStream << "illegal value";
      break;
  }
  return aStream;
}

std::ostream& operator<<(std::ostream& aStream,
                         const InputContextAction::FocusChange& aFocusChange) {
  switch (aFocusChange) {
    case InputContextAction::FOCUS_NOT_CHANGED:
      aStream << "FOCUS_NOT_CHANGED";
      break;
    case InputContextAction::GOT_FOCUS:
      aStream << "GOT_FOCUS";
      break;
    case InputContextAction::LOST_FOCUS:
      aStream << "LOST_FOCUS";
      break;
    case InputContextAction::MENU_GOT_PSEUDO_FOCUS:
      aStream << "MENU_GOT_PSEUDO_FOCUS";
      break;
    case InputContextAction::MENU_LOST_PSEUDO_FOCUS:
      aStream << "MENU_LOST_PSEUDO_FOCUS";
      break;
    case InputContextAction::WIDGET_CREATED:
      aStream << "WIDGET_CREATED";
      break;
    default:
      aStream << "illegal value";
      break;
  }
  return aStream;
}

std::ostream& operator<<(std::ostream& aStream,
                         const IMENotification::SelectionChangeData& aData) {
  if (!aData.IsInitialized()) {
    aStream << "{ IsInitialized()=false }";
    return aStream;
  }
  if (!aData.HasRange()) {
    aStream << "{ HasRange()=false }";
    return aStream;
  }
  aStream << "{ mOffset=" << aData.mOffset;
  if (aData.mString.Length() > 20) {
    aStream << ", mString.Length()=" << aData.mString.Length();
  } else {
    aStream << ", mString=\"" << NS_ConvertUTF16toUTF8(aData.mString)
            << "\" (Length()=" << aData.mString.Length() << ")";
  }

  aStream << ", GetWritingMode()=" << aData.GetWritingMode()
          << ", mReversed=" << (aData.mReversed ? "true" : "false")
          << ", mCausedByComposition="
          << (aData.mCausedByComposition ? "true" : "false")
          << ", mCausedBySelectionEvent="
          << (aData.mCausedBySelectionEvent ? "true" : "false")
          << ", mOccurredDuringComposition="
          << (aData.mOccurredDuringComposition ? "true" : "false") << " }";
  return aStream;
}

std::ostream& operator<<(std::ostream& aStream,
                         const IMENotification::TextChangeData& aData) {
  if (!aData.IsValid()) {
    aStream << "{ IsValid()=false }";
    return aStream;
  }
  aStream << "{ mStartOffset=" << aData.mStartOffset
          << ", mRemoveEndOffset=" << aData.mRemovedEndOffset
          << ", mAddedEndOffset=" << aData.mAddedEndOffset
          << ", mCausedOnlyByComposition="
          << (aData.mCausedOnlyByComposition ? "true" : "false")
          << ", mIncludingChangesDuringComposition="
          << (aData.mIncludingChangesDuringComposition ? "true" : "false")
          << ", mIncludingChangesWithoutComposition="
          << (aData.mIncludingChangesWithoutComposition ? "true" : "false")
          << " }";
  return aStream;
}

const char* ToChar(InputContext::Origin aOrigin) {
  switch (aOrigin) {
    case InputContext::ORIGIN_MAIN:
      return "ORIGIN_MAIN";
    case InputContext::ORIGIN_CONTENT:
      return "ORIGIN_CONTENT";
    default:
      return "Unexpected value";
  }
}

const char* ToChar(IMEMessage aIMEMessage) {
  switch (aIMEMessage) {
    case NOTIFY_IME_OF_NOTHING:
      return "NOTIFY_IME_OF_NOTHING";
    case NOTIFY_IME_OF_FOCUS:
      return "NOTIFY_IME_OF_FOCUS";
    case NOTIFY_IME_OF_BLUR:
      return "NOTIFY_IME_OF_BLUR";
    case NOTIFY_IME_OF_CONTENT_CHANGE:
      return "NOTIFY_IME_OF_CONTENT_CHANGE";
    case NOTIFY_IME_OF_COMPOSITION_EVENT_HANDLED:
      return "NOTIFY_IME_OF_COMPOSITION_EVENT_HANDLED";
    case NOTIFY_IME_OF_MOUSE_BUTTON_EVENT:
      return "NOTIFY_IME_OF_MOUSE_BUTTON_EVENT";
    case REQUEST_TO_COMMIT_COMPOSITION:
      return "REQUEST_TO_COMMIT_COMPOSITION";
    case REQUEST_TO_CANCEL_COMPOSITION:
      return "REQUEST_TO_CANCEL_COMPOSITION";
    default:
      return "Unexpected value";
  }
}

/******************************************************************************
 * NativeIMEContext
 ******************************************************************************/

void NativeIMEContext::Init(nsIWidget* aWidget) {
  if (!aWidget) {
    mRawNativeIMEContext = reinterpret_cast<uintptr_t>(nullptr);
    mOriginProcessID = static_cast<uint64_t>(-1);
    return;
  }
  if (!XRE_IsContentProcess()) {
    mRawNativeIMEContext = reinterpret_cast<uintptr_t>(
        aWidget->GetNativeData(NS_RAW_NATIVE_IME_CONTEXT));
    mOriginProcessID = 0;
    return;
  }
  // If this is created in a child process, aWidget is an instance of
  // PuppetWidget which doesn't support NS_RAW_NATIVE_IME_CONTEXT.
  // Instead of that PuppetWidget::GetNativeIMEContext() returns cached
  // native IME context of the parent process.
  *this = aWidget->GetNativeIMEContext();
}

void NativeIMEContext::InitWithRawNativeIMEContext(void* aRawNativeIMEContext) {
  if (NS_WARN_IF(!aRawNativeIMEContext)) {
    mRawNativeIMEContext = reinterpret_cast<uintptr_t>(nullptr);
    mOriginProcessID = static_cast<uint64_t>(-1);
    return;
  }
  mRawNativeIMEContext = reinterpret_cast<uintptr_t>(aRawNativeIMEContext);
  mOriginProcessID =
      XRE_IsContentProcess() ? dom::ContentChild::GetSingleton()->GetID() : 0;
}

/******************************************************************************
 * IMENotification::SelectionChangeData
 ******************************************************************************/

void IMENotification::SelectionChangeData::Assign(
    const WidgetQueryContentEvent& aQuerySelectedTextEvent) {
  MOZ_ASSERT(aQuerySelectedTextEvent.mMessage == eQuerySelectedText);
  MOZ_ASSERT(aQuerySelectedTextEvent.Succeeded());

  if (!(mIsInitialized = aQuerySelectedTextEvent.Succeeded())) {
    ClearSelectionData();
    return;
  }
  if ((mHasRange = aQuerySelectedTextEvent.FoundSelection())) {
    mOffset = aQuerySelectedTextEvent.mReply->StartOffset();
    mString = aQuerySelectedTextEvent.mReply->DataRef();
    mReversed = aQuerySelectedTextEvent.mReply->mReversed;
    SetWritingMode(aQuerySelectedTextEvent.mReply->WritingModeRef());
  } else {
    mOffset = UINT32_MAX;
    mString.Truncate();
    mReversed = false;
    // Let's keep the writing mode for avoiding temporarily changing the
    // writing mode at no selection range.
  }
}

void IMENotification::SelectionChangeData::SetWritingMode(
    const WritingMode& aWritingMode) {
  mWritingModeBits = aWritingMode.GetBits();
}

WritingMode IMENotification::SelectionChangeData::GetWritingMode() const {
  return WritingMode(mWritingModeBits);
}

bool IMENotification::SelectionChangeData::EqualsRange(
    const ContentSelection& aContentSelection) const {
  if (aContentSelection.HasRange() != HasRange()) {
    return false;
  }
  if (!HasRange()) {
    return true;
  }
  return mOffset == aContentSelection.OffsetAndDataRef().StartOffset() &&
         mString == aContentSelection.OffsetAndDataRef().DataRef();
}

bool IMENotification::SelectionChangeData::EqualsRangeAndWritingMode(
    const ContentSelection& aContentSelection) const {
  return EqualsRange(aContentSelection) &&
         mWritingModeBits == aContentSelection.WritingModeRef().GetBits();
}

/******************************************************************************
 * IMENotification::TextChangeData
 ******************************************************************************/

void IMENotification::TextChangeData::MergeWith(
    const IMENotification::TextChangeData& aOther) {
  MOZ_ASSERT(aOther.IsValid(), "Merging data must store valid data");
  MOZ_ASSERT(aOther.mStartOffset <= aOther.mRemovedEndOffset,
             "end of removed text must be same or larger than start");
  MOZ_ASSERT(aOther.mStartOffset <= aOther.mAddedEndOffset,
             "end of added text must be same or larger than start");

  if (!IsValid()) {
    *this = aOther;
    return;
  }

  // |mStartOffset| and |mRemovedEndOffset| represent all replaced or removed
  // text ranges.  I.e., mStartOffset should be the smallest offset of all
  // modified text ranges in old text.  |mRemovedEndOffset| should be the
  // largest end offset in old text of all modified text ranges.
  // |mAddedEndOffset| represents the end offset of all inserted text ranges.
  // I.e., only this is an offset in new text.
  // In other words, between mStartOffset and |mRemovedEndOffset| of the
  // premodified text was already removed.  And some text whose length is
  // |mAddedEndOffset - mStartOffset| is inserted to |mStartOffset|.  I.e.,
  // this allows IME to mark dirty the modified text range with |mStartOffset|
  // and |mRemovedEndOffset| if IME stores all text of the focused editor and
  // to compute new text length with |mAddedEndOffset| and |mRemovedEndOffset|.
  // Additionally, IME can retrieve only the text between |mStartOffset| and
  // |mAddedEndOffset| for updating stored text.

  // For comparing new and old |mStartOffset|/|mRemovedEndOffset| values, they
  // should be adjusted to be in same text. The |newData.mStartOffset| and
  // |newData.mRemovedEndOffset| should be computed as in old text because
  // |mStartOffset| and |mRemovedEndOffset| represent the modified text range
  // in the old text but even if some text before the values of the newData
  // has already been modified, the values don't include the changes.

  // For comparing new and old |mAddedEndOffset| values, they should be
  // adjusted to be in same text.  The |oldData.mAddedEndOffset| should be
  // computed as in the new text because |mAddedEndOffset| indicates the end
  // offset of inserted text in the new text but |oldData.mAddedEndOffset|
  // doesn't include any changes of the text before |newData.mAddedEndOffset|.

  const TextChangeData& newData = aOther;
  const TextChangeData oldData = *this;

  // mCausedOnlyByComposition should be true only when all changes are caused
  // by composition.
  mCausedOnlyByComposition =
      newData.mCausedOnlyByComposition && oldData.mCausedOnlyByComposition;

  // mIncludingChangesWithoutComposition should be true if at least one of
  // merged changes occurred without composition.
  mIncludingChangesWithoutComposition =
      newData.mIncludingChangesWithoutComposition ||
      oldData.mIncludingChangesWithoutComposition;

  // mIncludingChangesDuringComposition should be true when at least one of
  // the merged non-composition changes occurred during the latest composition.
  if (!newData.mCausedOnlyByComposition &&
      !newData.mIncludingChangesDuringComposition) {
    MOZ_ASSERT(newData.mIncludingChangesWithoutComposition);
    MOZ_ASSERT(mIncludingChangesWithoutComposition);
    // If new change is neither caused by composition nor occurred during
    // composition, set mIncludingChangesDuringComposition to false because
    // IME doesn't want outdated text changes as text change during current
    // composition.
    mIncludingChangesDuringComposition = false;
  } else {
    // Otherwise, set mIncludingChangesDuringComposition to true if either
    // oldData or newData includes changes during composition.
    mIncludingChangesDuringComposition =
        newData.mIncludingChangesDuringComposition ||
        oldData.mIncludingChangesDuringComposition;
  }

  if (newData.mStartOffset >= oldData.mAddedEndOffset) {
    // Case 1:
    // If new start is after old end offset of added text, it means that text
    // after the modified range is modified.  Like:
    // added range of old change:             +----------+
    // removed range of new change:                           +----------+
    // So, the old start offset is always the smaller offset.
    mStartOffset = oldData.mStartOffset;
    // The new end offset of removed text is moved by the old change and we
    // need to cancel the move of the old change for comparing the offsets in
    // same text because it doesn't make sensce to compare offsets in different
    // text.
    uint32_t newRemovedEndOffsetInOldText =
        newData.mRemovedEndOffset - oldData.Difference();
    mRemovedEndOffset =
        std::max(newRemovedEndOffsetInOldText, oldData.mRemovedEndOffset);
    // The new end offset of added text is always the larger offset.
    mAddedEndOffset = newData.mAddedEndOffset;
    return;
  }

  if (newData.mStartOffset >= oldData.mStartOffset) {
    // If new start is in the modified range, it means that new data changes
    // a part or all of the range.
    mStartOffset = oldData.mStartOffset;
    if (newData.mRemovedEndOffset >= oldData.mAddedEndOffset) {
      // Case 2:
      // If new end of removed text is greater than old end of added text, it
      // means that all or a part of modified range modified again and text
      // after the modified range is also modified.  Like:
      // added range of old change:             +----------+
      // removed range of new change:                   +----------+
      // So, the new removed end offset is moved by the old change and we need
      // to cancel the move of the old change for comparing the offsets in the
      // same text because it doesn't make sense to compare the offsets in
      // different text.
      uint32_t newRemovedEndOffsetInOldText =
          newData.mRemovedEndOffset - oldData.Difference();
      mRemovedEndOffset =
          std::max(newRemovedEndOffsetInOldText, oldData.mRemovedEndOffset);
      // The old end of added text is replaced by new change. So, it should be
      // same as the new start.  On the other hand, the new added end offset is
      // always same or larger.  Therefore, the merged end offset of added
      // text should be the new end offset of added text.
      mAddedEndOffset = newData.mAddedEndOffset;
      return;
    }

    // Case 3:
    // If new end of removed text is less than old end of added text, it means
    // that only a part of the modified range is modified again.  Like:
    // added range of old change:             +------------+
    // removed range of new change:               +-----+
    // So, the new end offset of removed text should be same as the old end
    // offset of removed text.  Therefore, the merged end offset of removed
    // text should be the old text change's |mRemovedEndOffset|.
    mRemovedEndOffset = oldData.mRemovedEndOffset;
    // The old end of added text is moved by new change.  So, we need to cancel
    // the move of the new change for comparing the offsets in same text.
    uint32_t oldAddedEndOffsetInNewText =
        oldData.mAddedEndOffset + newData.Difference();
    mAddedEndOffset =
        std::max(newData.mAddedEndOffset, oldAddedEndOffsetInNewText);
    return;
  }

  if (newData.mRemovedEndOffset >= oldData.mStartOffset) {
    // If new end of removed text is greater than old start (and new start is
    // less than old start), it means that a part of modified range is modified
    // again and some new text before the modified range is also modified.
    MOZ_ASSERT(newData.mStartOffset < oldData.mStartOffset,
               "new start offset should be less than old one here");
    mStartOffset = newData.mStartOffset;
    if (newData.mRemovedEndOffset >= oldData.mAddedEndOffset) {
      // Case 4:
      // If new end of removed text is greater than old end of added text, it
      // means that all modified text and text after the modified range is
      // modified.  Like:
      // added range of old change:             +----------+
      // removed range of new change:        +------------------+
      // So, the new end of removed text is moved by the old change.  Therefore,
      // we need to cancel the move of the old change for comparing the offsets
      // in same text because it doesn't make sense to compare the offsets in
      // different text.
      uint32_t newRemovedEndOffsetInOldText =
          newData.mRemovedEndOffset - oldData.Difference();
      mRemovedEndOffset =
          std::max(newRemovedEndOffsetInOldText, oldData.mRemovedEndOffset);
      // The old end of added text is replaced by new change.  So, the old end
      // offset of added text is same as new text change's start offset.  Then,
      // new change's end offset of added text is always same or larger than
      // it.  Therefore, merged end offset of added text is always the new end
      // offset of added text.
      mAddedEndOffset = newData.mAddedEndOffset;
      return;
    }

    // Case 5:
    // If new end of removed text is less than old end of added text, it
    // means that only a part of the modified range is modified again.  Like:
    // added range of old change:             +----------+
    // removed range of new change:      +----------+
    // So, the new end of removed text should be same as old end of removed
    // text for preventing end of removed text to be modified.  Therefore,
    // merged end offset of removed text is always the old end offset of removed
    // text.
    mRemovedEndOffset = oldData.mRemovedEndOffset;
    // The old end of added text is moved by this change.  So, we need to
    // cancel the move of the new change for comparing the offsets in same text
    // because it doesn't make sense to compare the offsets in different text.
    uint32_t oldAddedEndOffsetInNewText =
        oldData.mAddedEndOffset + newData.Difference();
    mAddedEndOffset =
        std::max(newData.mAddedEndOffset, oldAddedEndOffsetInNewText);
    return;
  }

  // Case 6:
  // Otherwise, i.e., both new end of added text and new start are less than
  // old start, text before the modified range is modified.  Like:
  // added range of old change:                  +----------+
  // removed range of new change: +----------+
  MOZ_ASSERT(newData.mStartOffset < oldData.mStartOffset,
             "new start offset should be less than old one here");
  mStartOffset = newData.mStartOffset;
  MOZ_ASSERT(newData.mRemovedEndOffset < oldData.mRemovedEndOffset,
             "new removed end offset should be less than old one here");
  mRemovedEndOffset = oldData.mRemovedEndOffset;
  // The end of added text should be adjusted with the new difference.
  uint32_t oldAddedEndOffsetInNewText =
      oldData.mAddedEndOffset + newData.Difference();
  mAddedEndOffset =
      std::max(newData.mAddedEndOffset, oldAddedEndOffsetInNewText);
}

}  // namespace widget
}  // namespace mozilla
