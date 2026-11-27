/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "gtest/gtest.h"
#include "mozilla/widget/IMEData.h"

namespace mozilla::widget {

using TextChangeData = IMENotification::TextChangeData;

/****************************************************************************
 * Basic text changes
 ****************************************************************************/

TEST(IMENotificationTextChangeDataTest, OnSequentiallyInsertingText)
{
  TextChangeData data;
  // Inserting 10 characters
  data.MergeWith(TextChangeData(10, 10, 20, false, false));
  // Inserting 15 characters
  data.MergeWith(TextChangeData(20, 20, 35, false, false));
  EXPECT_EQ(data.mStartOffset, 10u)
      << "mStartOffset should be the first offset";
  EXPECT_EQ(data.mRemovedEndOffset, 10u /* 20 - (20 - 10) */)
      << "mRemovedEndOffset should be the first end of removed text";
  EXPECT_EQ(data.mAddedEndOffset, 35u)
      << "mAddedEndOffset should be the last end of added text";
}

TEST(IMENotificationTextChangeDataTest,
     OnRemovingShorterRangeAndRemovingLongerRange)
{
  TextChangeData data;
  // Removing 10 characters
  data.MergeWith(TextChangeData(10, 20, 10, false, false));
  // Removing 20 characters
  data.MergeWith(TextChangeData(10, 30, 10, false, false));
  EXPECT_EQ(data.mStartOffset, 10u)
      << "mStartOffset should be the first offset";
  EXPECT_EQ(data.mRemovedEndOffset, 40u /* 30 - (10 - 20) */)
      << "mRemovedEndOffset should be the the last end of removed text with "
         "already removed length";
  EXPECT_EQ(data.mAddedEndOffset, 10u)
      << "mAddedEndOffset should be the last end of added text";
}

TEST(IMENotificationTextChangeDataTest,
     OnRemovingLongerRangeAndRemovingShorterRange)
{
  TextChangeData data;
  // Removing 10 characters
  data.MergeWith(TextChangeData(10, 20, 10, false, false));
  // Removing 5 characters
  data.MergeWith(TextChangeData(10, 15, 10, false, false));
  EXPECT_EQ(data.mStartOffset, 10u)
      << "mStartOffset should be the first offset";
  EXPECT_EQ(data.mRemovedEndOffset, 25u /* 15 - (10 - 20) */)
      << "mRemovedEndOffset should be the the last end of removed text with "
         "already removed length";
  EXPECT_EQ(data.mAddedEndOffset, 10u)
      << "mAddedEndOffset should be the last end of added text";
}

TEST(IMENotificationTextChangeDataTest, OnInsertingTextAfterInsertedPosition)
{
  TextChangeData data;
  // Inserting 10 characters
  data.MergeWith(TextChangeData(10, 10, 20, false, false));
  // Inserting 5 characters after the inserted position
  data.MergeWith(TextChangeData(55, 55, 60, false, false));
  EXPECT_EQ(data.mStartOffset, 10u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 45u /* 55 - (10 - 20) */)
      << "mRemovedEndOffset should be the the largest end of removed text "
         "without already added length";
  EXPECT_EQ(data.mAddedEndOffset, 60u)
      << "mAddedEndOffset should be the last end of added text";
}

TEST(IMENotificationTextChangeDataTest, OnRemovingTextAfterRemovedPosition)
{
  TextChangeData data;
  // Removing 10 characters
  data.MergeWith(TextChangeData(10, 20, 10, false, false));
  // Removing 13 characters after the removed position
  data.MergeWith(TextChangeData(55, 68, 55, false, false));
  EXPECT_EQ(data.mStartOffset, 10u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 78u /* 68 - (10 - 20) */)
      << "mRemovedEndOffset should be the the largest end of removed text with "
         "already removed length";
  EXPECT_EQ(data.mAddedEndOffset, 55u)
      << "mAddedEndOffset should be the largest end of added text";
}

TEST(IMENotificationTextChangeDataTest,
     OnSequentiallyInsertingTextAfterReplacingText1)
{
  TextChangeData data;
  // Replacing 5 characters with 2 characters
  data.MergeWith(TextChangeData(30, 35, 32, false, false));
  // Inserting 8 characters
  data.MergeWith(TextChangeData(32, 32, 40, false, false));
  EXPECT_EQ(data.mStartOffset, 30u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 35u /* 32 - (32 - 35) */)
      << "mRemovedEndOffset should be the the first end of removed text";
  EXPECT_EQ(data.mAddedEndOffset, 40u)
      << "mAddedEndOffset should be the last end of added text";
}

TEST(IMENotificationTextChangeDataTest,
     OnSequentiallyInsertingTextAfterReplacingText2)
{
  TextChangeData data;
  // Replacing 5 characters with 2 characters
  data.MergeWith(TextChangeData(30, 35, 32, false, false));
  // Inserting 1 character
  data.MergeWith(TextChangeData(32, 32, 33, false, false));
  EXPECT_EQ(data.mStartOffset, 30u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 35u /* 32 - (32 - 35) */)
      << "mRemovedEndOffset should be the the first end of removed text";
  EXPECT_EQ(data.mAddedEndOffset, 33u)
      << "mAddedEndOffset should be the last end of added text";
}

TEST(IMENotificationTextChangeDataTest,
     OnRemovingTextAndReplacingTextAfterTheRemovedPosition1)
{
  TextChangeData data;
  // Removing 5 characters
  data.MergeWith(TextChangeData(30, 35, 30, false, false));
  // Replacing 2 characters with 16 characters
  data.MergeWith(TextChangeData(32, 34, 48, false, false));
  EXPECT_EQ(data.mStartOffset, 30u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 39u /* 34 - (30 - 35) */)
      << "mRemovedEndOffset should be the the first end of removed text "
         "without already removed text";
  EXPECT_EQ(data.mAddedEndOffset, 48u)
      << "mAddedEndOffset should be the last end of added text";
}

TEST(IMENotificationTextChangeDataTest,
     OnRemovingTextAndReplacingTextAfterTheRemovedPosition2)
{
  TextChangeData data;
  // Removing 5 characters
  data.MergeWith(TextChangeData(30, 35, 30, false, false));
  // Replacing 6 characters with 4 characters
  data.MergeWith(TextChangeData(32, 38, 36, false, false));
  EXPECT_EQ(data.mStartOffset, 30u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 43u /* 38 - (30 - 35) */)
      << "mRemovedEndOffset should be the the first end of removed text "
         "without already removed text";
  EXPECT_EQ(data.mAddedEndOffset, 36u)
      << "mAddedEndOffset should be the last end of added text";
}

/****************************************************************************
 * Replacing text around added or replaced text
 ****************************************************************************/

TEST(IMENotificationTextChangeDataTest,
     OnInsertingTextAndReplacingPartOfInsertedText1)
{
  TextChangeData data;
  // Inserting 5 characters
  data.MergeWith(TextChangeData(50, 50, 55, false, false));
  // Replacing 7 characters with 1 character
  data.MergeWith(TextChangeData(53, 60, 54, false, false));
  EXPECT_EQ(data.mStartOffset, 50u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 55u /* 60 - (55 - 50) */)
      << "mRemovedEndOffset should be the the last end of removed text without "
         "already added text length";
  EXPECT_EQ(data.mAddedEndOffset, 54u)
      << "mAddedEndOffset should be the last end of added text";
}

TEST(IMENotificationTextChangeDataTest,
     OnInsertingTextAndReplacingPartOfInsertedText2)
{
  TextChangeData data;
  // Inserting 5 characters
  data.MergeWith(TextChangeData(50, 50, 55, false, false));
  // Replacing 8 characters with 14 characters
  data.MergeWith(TextChangeData(54, 62, 68, false, false));
  EXPECT_EQ(data.mStartOffset, 50u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 57u /* 62 - (55 - 50) */)
      << "mRemovedEndOffset should be the the last end of removed text without "
         "already added text length";
  EXPECT_EQ(data.mAddedEndOffset, 68u)
      << "mAddedEndOffset should be the last end of added text";
}

TEST(IMENotificationTextChangeDataTest,
     OnReplacingTextAndReplacingPartOfReplacedTextAgain1)
{
  TextChangeData data;
  // Replacing 12 characters with 9 characters
  data.MergeWith(TextChangeData(36, 48, 45, false, false));
  // Replacing 7 characters with 6 characters
  data.MergeWith(TextChangeData(43, 50, 49, false, false));
  EXPECT_EQ(data.mStartOffset, 36u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 53u /* 50 - (45 - 48) */)
      << "mRemovedEndOffset should be the the last end of removed text without "
         "already removed text length";
  EXPECT_EQ(data.mAddedEndOffset, 49u)
      << "mAddedEndOffset should be the last end of added text";
}

TEST(IMENotificationTextChangeDataTest,
     OnReplacingTextAndReplacingPartOfReplacedTextAgain2)
{
  TextChangeData data;
  // Replacing 16 characters with 17 characters
  data.MergeWith(TextChangeData(36, 52, 53, false, false));
  // Replacing 25 characters with 18 characters
  data.MergeWith(TextChangeData(43, 68, 61, false, false));
  EXPECT_EQ(data.mStartOffset, 36u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 67u /* 68 - (53 - 52) */)
      << "mRemovedEndOffset should be the the last end of removed text without "
         "already added text length";
  EXPECT_EQ(data.mAddedEndOffset, 61u)
      << "mAddedEndOffset should be the last end of added text";
}

/****************************************************************************
 * Replacing text starting from previously inserted or replaced text
 ****************************************************************************/

TEST(IMENotificationTextChangeDataTest, OnInsertingTextAfterInsertedText)
{
  TextChangeData data;
  // Inserting 10 characters
  data.MergeWith(TextChangeData(10, 10, 20, false, false));
  // Inserting 15 characters
  data.MergeWith(TextChangeData(15, 15, 30, false, false));
  EXPECT_EQ(data.mStartOffset, 10u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 10u)
      << "mRemovedEndOffset should be the the first end of removed text";
  EXPECT_EQ(data.mAddedEndOffset, 35u /* 20 + (30 - 15) */)
      << "mAddedEndOffset should be the first end of added text with added "
         "text length by the new change";
}

TEST(IMENotificationTextChangeDataTest,
     OnReplacingTextStartingFromMiddleOfInsertedText)
{
  TextChangeData data;
  // Inserting 5 characters
  data.MergeWith(TextChangeData(50, 50, 55, false, false));
  // Replacing 1 character with 4 characters
  data.MergeWith(TextChangeData(52, 53, 56, false, false));
  EXPECT_EQ(data.mStartOffset, 50u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 50u)
      << "mRemovedEndOffset should be the the first end of removed text";
  EXPECT_EQ(data.mAddedEndOffset, 58u /* 55 + (56 - 53) */)
      << "mAddedEndOffset should be the first end of added text with added "
         "text length by the new change";
}

TEST(IMENotificationTextChangeDataTest,
     OnReplacingTextStartingFromMiddleOfReplacedText1)
{
  TextChangeData data;
  // Replacing 12 characters with 9 characters
  data.MergeWith(TextChangeData(36, 48, 45, false, false));
  // Replacing 1 character with 13 characters
  data.MergeWith(TextChangeData(37, 38, 50, false, false));
  EXPECT_EQ(data.mStartOffset, 36u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 48u)
      << "mRemovedEndOffset should be the the first end of removed text";
  EXPECT_EQ(data.mAddedEndOffset, 57u /* 45 + (50 - 38) */)
      << "mAddedEndOffset should be the first end of added text with added "
         "text length by the new change";
}

TEST(IMENotificationTextChangeDataTest,
     OnReplacingTextStartingFromMiddleOfReplacedText2)
{
  TextChangeData data;
  // Replacing 16 characters with 21 characters
  data.MergeWith(TextChangeData(32, 48, 53, false, false));
  // Replacing 7 characters with 9 characters
  data.MergeWith(TextChangeData(43, 50, 52, false, false));
  EXPECT_EQ(data.mStartOffset, 32u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 48u)
      << "mRemovedEndOffset should be the the last end of removed text without "
         "already added text length";
  EXPECT_EQ(data.mAddedEndOffset, 55u /* 53 + (52 - 50) */)
      << "mAddedEndOffset should be the first end of added text with added "
         "text length by the new change";
}

TEST(IMENotificationTextChangeDataTest,
     OnReplacingTextStartingFromMiddleOfReplacedText3)
{
  TextChangeData data;
  // Replacing 12 characters with 14 characters
  data.MergeWith(TextChangeData(36, 48, 50, false, false));
  // Replacing 12 characters with 10 characters
  data.MergeWith(TextChangeData(37, 49, 47, false, false));
  EXPECT_EQ(data.mStartOffset, 36u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 48u)
      << "mRemovedEndOffset should be the the first end of removed "
         "text";
  EXPECT_EQ(data.mAddedEndOffset, 48u /* 50 + (47 - 49) */)
      << "mAddedEndOffset should be the first end of added text without "
         "removed text length by the new change";
}

TEST(IMENotificationTextChangeDataTest,
     OnReplacingTextStartingFromMiddleOfReplacedText4)
{
  TextChangeData data;
  // Replacing 16 characters with 21 characters
  data.MergeWith(TextChangeData(32, 48, 53, false, false));
  // Replacing 7 characters with 4 characters
  data.MergeWith(TextChangeData(43, 50, 47, false, false));
  EXPECT_EQ(data.mStartOffset, 32u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 48u)
      << "mRemovedEndOffset should be the the last end of removed text without "
         "already added text length";
  EXPECT_EQ(data.mAddedEndOffset, 50u /* 53 + (47 - 50) */)
      << "mAddedEndOffset should be the first end of added text without "
         "removed text length by the new change";
}

/****************************************************************************
 * Replacing text which contains all of previously changed text
 ****************************************************************************/

TEST(IMENotificationTextChangeDataTest,
     OnReplacingTextContainingAllInsertedText)
{
  TextChangeData data;
  // Inserting 5 characters
  data.MergeWith(TextChangeData(50, 50, 55, false, false));
  // Replacing 22 characters with 24 characters
  data.MergeWith(TextChangeData(44, 66, 68, false, false));
  EXPECT_EQ(data.mStartOffset, 44u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 61u /* 66 - (55 - 50) */)
      << "mRemovedEndOffset should be the the last end of removed text without "
         "already added text length";
  EXPECT_EQ(data.mAddedEndOffset, 68u)
      << "mAddedEndOffset should be the last end of added text";
}

TEST(IMENotificationTextChangeDataTest,
     OnReplacingTextContainingRemovedTextPosition)
{
  TextChangeData data;
  // Removing 12 characters
  data.MergeWith(TextChangeData(50, 62, 50, false, false));
  // Replacing 22 characters with 24 characters
  data.MergeWith(TextChangeData(44, 66, 68, false, false));
  EXPECT_EQ(data.mStartOffset, 44u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 78u /* 66 - (50 - 62) */)
      << "mRemovedEndOffset should be the the last end of removed text without "
         "already removed text length";
  EXPECT_EQ(data.mAddedEndOffset, 68u)
      << "mAddedEndOffset should be the last end of added text";
}

TEST(IMENotificationTextChangeDataTest,
     OnReplacingTextContainingAllReplacedText1)
{
  TextChangeData data;
  // Replacing 12 characters with 10 characters
  data.MergeWith(TextChangeData(50, 62, 60, false, false));
  // Replacing 79 characters with 81 characters
  data.MergeWith(TextChangeData(49, 128, 130, false, false));
  EXPECT_EQ(data.mStartOffset, 49u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 130u /* 128 - (60 - 62) */)
      << "mRemovedEndOffset should be the the last end of removed text without "
         "already removed text length";
  EXPECT_EQ(data.mAddedEndOffset, 130u)
      << "mAddedEndOffset should be the last end of added text";
}

TEST(IMENotificationTextChangeDataTest,
     OnReplacingTextContainingAllReplacedText2)
{
  TextChangeData data;
  // Replacing 11 characters with 23 characters
  data.MergeWith(TextChangeData(50, 61, 73, false, false));
  // Replacing 56 characters with 6 characters
  data.MergeWith(TextChangeData(44, 100, 50, false, false));
  EXPECT_EQ(data.mStartOffset, 44u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 88u /* 100 - (73 - 61) */)
      << "mRemovedEndOffset should be the the last end of removed text with "
         "already added text length";
  EXPECT_EQ(data.mAddedEndOffset, 50u)
      << "mAddedEndOffset should be the last end of added text";
}

/****************************************************************************
 * Replacing text ending in previously inserted or replaced text
 ****************************************************************************/

TEST(IMENotificationTextChangeDataTest, OnReplacingTextEndingInInsertedText)
{
  TextChangeData data;
  // Inserting 5 characters
  data.MergeWith(TextChangeData(50, 50, 55, false, false));
  // Replacing 4 characters with 1 character
  data.MergeWith(TextChangeData(48, 52, 49, false, false));
  EXPECT_EQ(data.mStartOffset, 48u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 50u)
      << "mRemovedEndOffset should be the the first end of removed text";
  EXPECT_EQ(data.mAddedEndOffset, 52u /* 55 + (49 - 52) */)
      << "mAddedEndOffset should be the first end of added text with added "
         "text length by the new change";
}

TEST(IMENotificationTextChangeDataTest, OnReplacingTextEndingInReplacedText1)
{
  TextChangeData data;
  // Replacing 10 characters with 8 characters
  data.MergeWith(TextChangeData(50, 60, 58, false, false));
  // Replacing 7 characters with 5 characters
  data.MergeWith(TextChangeData(43, 50, 48, false, false));
  EXPECT_EQ(data.mStartOffset, 43u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 60u)
      << "mRemovedEndOffset should be the the first end of removed text";
  EXPECT_EQ(data.mAddedEndOffset, 56u /* 58 + (48 - 50) */)
      << "mAddedEndOffset should be the first end of added text without "
         "removed text length by the new change";
}

TEST(IMENotificationTextChangeDataTest, OnReplacingTextEndingInReplacedText2)
{
  TextChangeData data;
  // Replacing 10 characters with 18 characters
  data.MergeWith(TextChangeData(50, 60, 68, false, false));
  // Replacing 12 characters with 10 characters
  data.MergeWith(TextChangeData(43, 55, 53, false, false));
  EXPECT_EQ(data.mStartOffset, 43u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 60u)
      << "mRemovedEndOffset should be the the first end of removed text";
  EXPECT_EQ(data.mAddedEndOffset, 66u /* 68 + (53 - 55) */)
      << "mAddedEndOffset should be the first end of added text without "
         "removed text length by the new change";
}

TEST(IMENotificationTextChangeDataTest, OnReplacingTextEndingInReplacedText3)
{
  TextChangeData data;
  // Replacing 10 characters with 8 characters
  data.MergeWith(TextChangeData(50, 60, 58, false, false));
  // Replacing 7 characters with 78 characters
  data.MergeWith(TextChangeData(43, 50, 128, false, false));
  EXPECT_EQ(data.mStartOffset, 43u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 60u)
      << "mRemovedEndOffset should be the the first end of removed text";
  EXPECT_EQ(data.mAddedEndOffset, 136u /* 58 + (128 - 50) */)
      << "mAddedEndOffset should be the first end of added text with added "
         "text length by the new change";
}

TEST(IMENotificationTextChangeDataTest, OnReplacingTextEndingInReplacedText4)
{
  TextChangeData data;
  // Replacing 10 characters with 18 characters
  data.MergeWith(TextChangeData(50, 60, 68, false, false));
  // Replacing 12 characters with 22 characters
  data.MergeWith(TextChangeData(43, 55, 65, false, false));
  EXPECT_EQ(data.mStartOffset, 43u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 60u)
      << "mRemovedEndOffset should be the the first end of removed text";
  EXPECT_EQ(data.mAddedEndOffset, 78u /* 68 + (65 - 55) */)
      << "mAddedEndOffset should be the first end of added text with added "
         "text length by the new change";
}

/****************************************************************************
 * Text change before previously edited
 ****************************************************************************/

TEST(IMENotificationTextChangeDataTest, OnInsertingTextBeforeInsertedText)
{
  TextChangeData data;
  // Inserting 15 characters
  data.MergeWith(TextChangeData(30, 30, 45, false, false));
  // Inserting 10 characters
  data.MergeWith(TextChangeData(10, 10, 20, false, false));
  EXPECT_EQ(data.mStartOffset, 10u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 30u)
      << "mRemovedEndOffset should be the the largest end of removed text";
  EXPECT_EQ(data.mAddedEndOffset, 55u /* 45 + (20 - 10) */)
      << "mAddedEndOffset should be the first end of added text with added "
         "text length by the new change";
}

TEST(IMENotificationTextChangeDataTest, OnRemovingTextBeforeRemovedPosition)
{
  TextChangeData data;
  // Removing 5 characters
  data.MergeWith(TextChangeData(30, 35, 30, false, false));
  // Removing 15 characters
  data.MergeWith(TextChangeData(10, 25, 10, false, false));
  EXPECT_EQ(data.mStartOffset, 10u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 35u)
      << "mRemovedEndOffset should be the the largest end of removed text";
  EXPECT_EQ(data.mAddedEndOffset, 15u /* 30 - (25 - 10) */)
      << "mAddedEndOffset should be the first end of added text with removed "
         "text length by the new change";
}

TEST(IMENotificationTextChangeDataTest, OnReplacingTextBeforeReplacedText1)
{
  TextChangeData data;
  // Replacing 15 characters with 20 characters
  data.MergeWith(TextChangeData(50, 65, 70, false, false));
  // Replacing 11 characters with 2 characters
  data.MergeWith(TextChangeData(13, 24, 15, false, false));
  EXPECT_EQ(data.mStartOffset, 13u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 65u)
      << "mRemovedEndOffset should be the the largest end of removed text";
  EXPECT_EQ(data.mAddedEndOffset, 61u /* 70 + (15 - 24) */)
      << "mAddedEndOffset should be the first end of added text without "
         "removed text length by the new change";
}

TEST(IMENotificationTextChangeDataTest, OnReplacingTextBeforeReplacedText2)
{
  TextChangeData data;
  // Replacing 15 characters with 20 characters
  data.MergeWith(TextChangeData(50, 65, 70, false, false));
  // Replacing 11 characters with 23 characters
  data.MergeWith(TextChangeData(13, 24, 36, false, false));
  EXPECT_EQ(data.mStartOffset, 13u)
      << "mStartOffset should be the smallest offset";
  EXPECT_EQ(data.mRemovedEndOffset, 65u)
      << "mRemovedEndOffset should be the the largest end of removed text";
  EXPECT_EQ(data.mAddedEndOffset, 82u /* 70 + (36 - 24) */)
      << "mAddedEndOffset should be the first end of added text without "
         "removed text length by the new change";
}

}  // namespace mozilla::widget
