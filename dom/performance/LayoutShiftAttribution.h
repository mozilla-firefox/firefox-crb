/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_LayoutShiftAttribution_h_
#define mozilla_dom_LayoutShiftAttribution_h_

#include "Units.h"
#include "nsCOMPtr.h"
#include "nsCycleCollectionParticipant.h"
#include "nsIWeakReferenceUtils.h"
#include "nsWrapperCache.h"

class nsINode;

namespace mozilla::dom {

class DOMRectReadOnly;

// https://wicg.github.io/layout-instability/#sec-layout-shift-attribution
class LayoutShiftAttribution final : public nsISupports, public nsWrapperCache {
 public:
  NS_DECL_CYCLE_COLLECTING_ISUPPORTS_FINAL
  NS_DECL_CYCLE_COLLECTION_WRAPPERCACHE_CLASS(LayoutShiftAttribution)

  LayoutShiftAttribution(nsISupports* aParent, nsINode* aNode,
                         const CSSRect& aPreviousRect,
                         const CSSRect& aCurrentRect);

  nsISupports* GetParentObject() const { return mParent; }

  JSObject* WrapObject(JSContext* aCx,
                       JS::Handle<JSObject*> aGivenProto) override;

  nsINode* GetNode() const;
  DOMRectReadOnly* PreviousRect() const { return mPreviousRect; }
  DOMRectReadOnly* CurrentRect() const { return mCurrentRect; }

 private:
  ~LayoutShiftAttribution();

  nsCOMPtr<nsISupports> mParent;
  // Weak, so that buffered entries don't keep removed nodes alive.
  nsWeakPtr mNode;
  RefPtr<DOMRectReadOnly> mPreviousRect;
  RefPtr<DOMRectReadOnly> mCurrentRect;
};

}  // namespace mozilla::dom

#endif  // mozilla_dom_LayoutShiftAttribution_h_
