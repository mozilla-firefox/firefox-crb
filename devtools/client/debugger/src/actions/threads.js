/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */

import {
  createThread,
  createTargetSource,
  makeTargetSourceId,
} from "../client/firefox/create";
import { getSourcesToRemoveForThread, getSource } from "../selectors/index";
import { removeSources } from "./sources/removeSources";
import { checkNewSources } from "./sources/newSources";

export function addTarget(targetFront) {
  return async ({ dispatch }) => {
    await dispatch({
      type: "INSERT_THREAD",
      newThread: createThread(targetFront),
    });
    if (
      targetFront.targetType === "frame" &&
      // @backward-compat { version 163 } Older servers fetch the html content through
      // the inline scripts source actors, and do not handle html which do not have inline scripts,
      // so we need to check for the trait to avoid fetching the html content on older servers.
      // Remove this condition check when the client is on version 161 or higher..
      targetFront.getTrait("supportsGetSourceContentForHTMLResource")
    ) {
      const targetSources = [createTargetSource(targetFront)];
      await dispatch({
        type: "ADD_SOURCES",
        sources: targetSources,
      });

      await dispatch(checkNewSources(targetSources));
    }
  };
}

export function removeTarget(targetFront) {
  return async ({ getState, dispatch }) => {
    const threadActorID = targetFront.targetForm.threadActor;

    // Just before emitting the REMOVE_THREAD action,
    // synchronously compute the list of source and source actor objects
    // which should be removed as that one target get removed.
    //
    // The list of source objects isn't trivial to compute as these objects
    // are shared across targets/threads.
    const { actors, sources } = getSourcesToRemoveForThread(
      getState(),
      threadActorID
    );

    // If there are no inline scripts in the html, this means the target source
    const targetSource = getSource(getState(), makeTargetSourceId(targetFront));
    if (targetSource && !sources.includes(targetSource)) {
      sources.push(targetSource);
    }

    // Notify the reducers that a target/thread is being removed.
    // This will be fired on navigation for all existing targets.
    // That except the top target, when pausing on unload, where the top target may still hold longer.
    // Also except for service worker targets, which may be kept alive.
    dispatch({
      type: "REMOVE_THREAD",
      threadActorID,
    });
    // A distinct action is used to notify about all the sources and source actors objects
    // to be removed. This action is shared by some other codepath. Like removing the pretty printed source.
    await dispatch(removeSources(sources, actors));
  };
}

export function toggleJavaScriptEnabled(enabled) {
  return async ({ dispatch, client }) => {
    await client.toggleJavaScriptEnabled(enabled);
    dispatch({
      type: "TOGGLE_JAVASCRIPT_ENABLED",
      value: enabled,
    });
  };
}
