/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "LayoutShiftAttribution.h"

#include "mozilla/dom/DOMRect.h"
#include "mozilla/dom/LayoutShiftBinding.h"
#include "nsContentUtils.h"
#include "nsINode.h"

namespace mozilla::dom {

NS_IMPL_CYCLE_COLLECTION_WRAPPERCACHE(LayoutShiftAttribution, mParent,
                                      mPreviousRect, mCurrentRect)

NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(LayoutShiftAttribution)
  NS_WRAPPERCACHE_INTERFACE_MAP_ENTRY
  NS_INTERFACE_MAP_ENTRY(nsISupports)
NS_INTERFACE_MAP_END

NS_IMPL_CYCLE_COLLECTING_ADDREF(LayoutShiftAttribution)
NS_IMPL_CYCLE_COLLECTING_RELEASE(LayoutShiftAttribution)

LayoutShiftAttribution::LayoutShiftAttribution(nsISupports* aParent,
                                               nsINode* aNode,
                                               const CSSRect& aPreviousRect,
                                               const CSSRect& aCurrentRect)
    : mParent(aParent),
      mNode(aNode ? do_GetWeakReference(aNode) : nullptr),
      mPreviousRect(
          new DOMRectReadOnly(aParent, aPreviousRect.X(), aPreviousRect.Y(),
                              aPreviousRect.Width(), aPreviousRect.Height())),
      mCurrentRect(new DOMRectReadOnly(aParent, aCurrentRect.X(),
                                       aCurrentRect.Y(), aCurrentRect.Width(),
                                       aCurrentRect.Height())) {}

LayoutShiftAttribution::~LayoutShiftAttribution() = default;

JSObject* LayoutShiftAttribution::WrapObject(
    JSContext* aCx, JS::Handle<JSObject*> aGivenProto) {
  return LayoutShiftAttribution_Binding::Wrap(aCx, this, aGivenProto);
}

nsINode* LayoutShiftAttribution::GetNode() const {
  // https://wicg.github.io/layout-instability/#dom-layoutshiftattribution-node
  nsCOMPtr<nsINode> node = do_QueryReferent(mNode);
  if (!node ||
      !nsContentUtils::IsExposedForPaintTiming(node, node->OwnerDoc())) {
    return nullptr;
  }
  return node;
}

}  // namespace mozilla::dom
