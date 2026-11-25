/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef mozilla_layers_NativeLayerRemoteChild_h
#define mozilla_layers_NativeLayerRemoteChild_h

#include "mozilla/layers/PNativeLayerRemoteChild.h"

namespace mozilla {
namespace layers {

class NativeLayerRemoteChild : public PNativeLayerRemoteChild {
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(NativeLayerRemoteChild);

 public:
  class Listener {
   public:
    virtual void PresentsFramesAtTime(uint64_t aID, bool aAtTime) = 0;
  };
  void SetListener(Listener* aListener) { mListener = aListener; }

  mozilla::ipc::IPCResult RecvPresentsFramesAtTime(const uint64_t& aID,
                                                   const bool& aAtTime) {
    if (mListener) {
      mListener->PresentsFramesAtTime(aID, aAtTime);
    }
    return IPC_OK();
  }

 protected:
  Listener* MOZ_NON_OWNING_REF mListener = nullptr;

  ~NativeLayerRemoteChild() = default;
};

}  // namespace layers
}  // namespace mozilla

#endif  // mozilla_layers_NativeLayerRemoteChild_h
