/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "FileSystemParentTest.h"
#include "FileSystemParentTestHelpers.h"
#include "FileSystemParentTypes.h"
#include "TestHelpers.h"
#include "gtest/gtest.h"
#include "mozilla/dom/FileSystemSnapshot.h"
#include "nsICloneableInputStream.h"
#include "nsIIPCSerializableInputStream.h"
#include "nsStreamUtils.h"
#include "nsStringStream.h"

namespace mozilla::dom::fs::test {

TEST(TestSnapshotInputStream, CloneReflectsStateWhenMade) {
  nsCOMPtr<nsIInputStream> inner;
  ASSERT_NSEQ(NS_OK,
              NS_NewCStringInputStream(getter_AddRefs(inner), "snapshot"_ns));

  auto state = MakeRefPtr<SnapshotState>();
  nsCOMPtr<nsIInputStream> stream = new SnapshotInputStream(inner, state);

  // Serializable streams hand a file descriptor to the content process,
  // which could not be revoked.
  nsCOMPtr<nsIIPCSerializableInputStream> serializable =
      do_QueryInterface(stream);
  ASSERT_FALSE(serializable);

  nsCOMPtr<nsICloneableInputStream> cloneable = do_QueryInterface(stream);
  ASSERT_TRUE(cloneable);

  nsCOMPtr<nsIInputStream> before;
  ASSERT_NSEQ(NS_OK, cloneable->Clone(getter_AddRefs(before)));

  state->Invalidate(NS_ERROR_DOM_FILE_NOT_READABLE_ERR);

  nsCOMPtr<nsIInputStream> after;
  ASSERT_NSEQ(NS_OK, cloneable->Clone(getter_AddRefs(after)));

  nsCString data;
  ASSERT_NSEQ(NS_OK, NS_ConsumeStream(before, UINT32_MAX, data));
  ASSERT_STREQ("snapshot", data.get());

  ASSERT_NSEQ(NS_ERROR_DOM_FILE_NOT_READABLE_ERR,
              NS_ConsumeStream(after, UINT32_MAX, data));
}

class TestFileSystemSnapshot : public FileSystemParentTest {
 protected:
  void CreateFileWithTestData(EntryId& aEntryId, FileId& aMainFileId) {
    ASSERT_NO_FATAL_FAILURE(EnsureDataManager());
    ASSERT_NO_FATAL_FAILURE(CreateNewEmptyFile(aEntryId));

    ASSERT_NO_FATAL_FAILURE(LockExclusive(aEntryId));
    ASSERT_NO_FATAL_FAILURE(WriteDataToFile(aEntryId, GetTestData()));
    ASSERT_NO_FATAL_FAILURE(UnlockExclusive(aEntryId));

    ASSERT_NO_FATAL_FAILURE(GetMainFileId(aEntryId, aMainFileId));
  }
};

TEST_F(TestFileSystemSnapshot, ExclusiveLockInvalidates) {
  EntryId entryId;
  FileId mainFileId(""_ns);
  ASSERT_NO_FATAL_FAILURE(CreateFileWithTestData(entryId, mainFileId));

  auto state = MakeRefPtr<SnapshotState>();
  ASSERT_NO_FATAL_FAILURE(RegisterSnapshot(mainFileId, state));
  ASSERT_NSEQ(NS_OK, state->Status());

  ASSERT_NO_FATAL_FAILURE(LockExclusive(entryId));
  ASSERT_NSEQ(NS_ERROR_DOM_FILE_NOT_READABLE_ERR, state->Status());

  ASSERT_NO_FATAL_FAILURE(UnlockExclusive(entryId));
}

TEST_F(TestFileSystemSnapshot, SharedLockCommitInvalidates) {
  EntryId entryId;
  FileId mainFileId(""_ns);
  ASSERT_NO_FATAL_FAILURE(CreateFileWithTestData(entryId, mainFileId));

  auto state = MakeRefPtr<SnapshotState>();
  ASSERT_NO_FATAL_FAILURE(RegisterSnapshot(mainFileId, state));

  FileId tempFileId(""_ns);
  ASSERT_NO_FATAL_FAILURE(LockShared(entryId, tempFileId));
  ASSERT_NSEQ(NS_OK, state->Status());

  ASSERT_NO_FATAL_FAILURE(WriteDataToFileId(entryId, tempFileId, "new"_ns));
  ASSERT_NSEQ(NS_OK, state->Status());

  ASSERT_NO_FATAL_FAILURE(
      UnlockShared(entryId, tempFileId, /* aAbort */ false));
  ASSERT_NSEQ(NS_ERROR_DOM_FILE_NOT_READABLE_ERR, state->Status());

  FileId newMainFileId(""_ns);
  ASSERT_NO_FATAL_FAILURE(GetMainFileId(entryId, newMainFileId));
  ASSERT_EQ(tempFileId, newMainFileId);
}

TEST_F(TestFileSystemSnapshot, SharedLockAbortKeepsSnapshot) {
  EntryId entryId;
  FileId mainFileId(""_ns);
  ASSERT_NO_FATAL_FAILURE(CreateFileWithTestData(entryId, mainFileId));

  auto state = MakeRefPtr<SnapshotState>();
  ASSERT_NO_FATAL_FAILURE(RegisterSnapshot(mainFileId, state));

  FileId tempFileId(""_ns);
  ASSERT_NO_FATAL_FAILURE(LockShared(entryId, tempFileId));
  ASSERT_NO_FATAL_FAILURE(WriteDataToFileId(entryId, tempFileId, "new"_ns));
  ASSERT_NO_FATAL_FAILURE(
      UnlockShared(entryId, tempFileId, /* aAbort */ true));

  ASSERT_NSEQ(NS_OK, state->Status());
}

TEST_F(TestFileSystemSnapshot, InvalidationIsPerMainFile) {
  EntryId entryId;
  FileId mainFileId(""_ns);
  ASSERT_NO_FATAL_FAILURE(CreateFileWithTestData(entryId, mainFileId));

  FileId tempFileId(""_ns);
  ASSERT_NO_FATAL_FAILURE(LockShared(entryId, tempFileId));
  ASSERT_NO_FATAL_FAILURE(WriteDataToFileId(entryId, tempFileId, "new"_ns));
  ASSERT_NO_FATAL_FAILURE(
      UnlockShared(entryId, tempFileId, /* aAbort */ false));

  auto state = MakeRefPtr<SnapshotState>();
  ASSERT_NO_FATAL_FAILURE(RegisterSnapshot(tempFileId, state));

  ASSERT_NO_FATAL_FAILURE(LockExclusive(entryId));
  ASSERT_NSEQ(NS_ERROR_DOM_FILE_NOT_READABLE_ERR, state->Status());
  ASSERT_NO_FATAL_FAILURE(UnlockExclusive(entryId));
}

}  // namespace mozilla::dom::fs::test
