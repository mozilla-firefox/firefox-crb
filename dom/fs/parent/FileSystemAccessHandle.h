/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef DOM_FS_PARENT_FILESYSTEMACCESSHANDLE_H_
#define DOM_FS_PARENT_FILESYSTEMACCESSHANDLE_H_

#include "FileSystemStreamCallbacks.h"
#include "mozilla/Atomics.h"
#include "mozilla/MozPromise.h"
#include "mozilla/NotNull.h"
#include "mozilla/RefPtr.h"
#include "mozilla/dom/FileSystemTypes.h"
#include "mozilla/dom/quota/ForwardDecls.h"
#include "mozilla/dom/quota/WriteLease.h"
#include "nsISupportsImpl.h"
#include "nsString.h"

enum class nsresult : uint32_t;

namespace mozilla {

class TaskQueue;

namespace ipc {
class RandomAccessStreamParams;
}

namespace dom {

class FileSystemAccessHandleControlParent;
class FileSystemAccessHandleParent;

namespace fs {

template <class T>
class Registered;

namespace data {

class FileSystemDataManager;

}  // namespace data
}  // namespace fs

class FileSystemAccessHandle : public FileSystemStreamCallbacks {
 public:
  using CreateResult = std::pair<fs::Registered<FileSystemAccessHandle>,
                                 mozilla::ipc::RandomAccessStreamParams>;
  // IsExclusive is true because we want to allow moving of CreateResult.
  // There's always just one consumer anyway (When IsExclusive is true, there
  // can be at most one call to either Then or ChainTo).
  using CreatePromise = MozPromise<CreateResult, nsresult,
                                   /* IsExclusive */ true>;
  static RefPtr<CreatePromise> Create(
      RefPtr<fs::data::FileSystemDataManager> aDataManager,
      const fs::EntryId& aEntryId);

  NS_DECL_ISUPPORTS_INHERITED

  void Register();

  void Unregister();

  void RegisterActor(NotNull<FileSystemAccessHandleParent*> aActor);

  void UnregisterActor(NotNull<FileSystemAccessHandleParent*> aActor);

  void RegisterControlActor(
      NotNull<FileSystemAccessHandleControlParent*> aControlActor);

  void UnregisterControlActor(
      NotNull<FileSystemAccessHandleControlParent*> aControlActor);

  bool IsOpen() const;

  RefPtr<BoolPromise> BeginClose();

 private:
  FileSystemAccessHandle(RefPtr<fs::data::FileSystemDataManager> aDataManager,
                         const fs::EntryId& aEntryId,
                         MovingNotNull<RefPtr<TaskQueue>> aIOTaskQueue);

  ~FileSystemAccessHandle();

  bool IsInactive() const;

  using InitPromise =
      MozPromise<mozilla::ipc::RandomAccessStreamParams, nsresult,
                 /* IsExclusive */ true>;
  RefPtr<InitPromise> BeginInit();

  RefPtr<InitPromise> FinishInit();

  const fs::EntryId mEntryId;
  RefPtr<fs::data::FileSystemDataManager> mDataManager;
  const NotNull<RefPtr<TaskQueue>> mIOTaskQueue;
  // Acquired on the data manager's IO task queue before locking. Released on
  // that queue after the handle's IO queue has shut down and the entry is
  // unlocked, covering usage updates and direct writes from the child.
  quota::WriteLease mWriteLease;
  FileSystemAccessHandleParent* mActor;
  FileSystemAccessHandleControlParent* mControlActor;
  Atomic<uint32_t, ReleaseAcquire> mRegCount;
  bool mLocked;
  bool mRegistered;
  bool mClosed;
};

}  // namespace dom
}  // namespace mozilla

#endif  // DOM_FS_PARENT_FILESYSTEMACCESSHANDLE_H_
