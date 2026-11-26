/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */

/**
 * Sources content reducer.
 *
 * This store the textual content for each source.
 */

import { pending, fulfilled, rejected } from "../utils/async-value";

export function initialSourcesContentState() {
  return {
    /**
     * Text content of all original and HTML sources.
     * In both these cases their content is indexed by their source ID
     * and so aren't specific to any source actor.
     *
     * This is large data, so this is only fetched on-demand for a subset of sources.
     * This state attribute is mutable in order to avoid cloning this possibly large map
     * on each new source. But selectors are never based on the map. Instead they only
     * query elements of the map.
     *
     * Map(source id => AsyncValue<String>)
     */
    mutableSourceTextContentMapBySourceId: new Map(),

    /**
     * Text content of all other sources (<script>, eval(), workers,...),
     * which are derived from a very specific source actor.
     *
     * Map(source actor id => AsyncValue<String>)
     */
    mutableSourceTextContentMapBySourceActorId: new Map(),

    /**
     * Incremental number that is bumped each time we navigate to a new page.
     *
     * This is used to better handle async race condition where we mix previous page data
     * with the new page. As sources are keyed by URL we may easily conflate the two page loads data.
     */
    epoch: 1,
  };
}

function update(state = initialSourcesContentState(), action) {
  switch (action.type) {
    case "LOAD_ORIGINAL_SOURCE_TEXT":
    case "LOAD_HTML_SOURCE_TEXT":
      if (!action.source) {
        throw new Error("Missing source");
      }
      return updateSourceTextContent(state, action);

    case "LOAD_GENERATED_SOURCE_TEXT":
      if (!action.sourceActor) {
        throw new Error("Missing source actor.");
      }
      return updateSourceTextContent(state, action);

    case "REMOVE_GENERATED_SOURCE_TEXT":
      state.mutableSourceTextContentMapBySourceActorId.delete(action.actorId);
      return { ...state };

    case "REMOVE_SOURCES":
      return removeAllSourceTextContentForSourcesAndActors(state, action);
  }

  return state;
}

/*
 * Update a source's loaded text content.
 */
function updateSourceTextContent(state, action) {
  // If there was a navigation between the time the action was started and
  // completed, we don't want to update the store.
  if (action.epoch !== state.epoch) {
    return state;
  }

  let content;
  if (action.status === "start") {
    content = pending();
  } else if (action.status === "error") {
    content = rejected(action.error);
  } else if (typeof action.value.text === "string") {
    content = fulfilled({
      type: "text",
      value: action.value.text,
      contentType: action.value.contentType,
    });
  } else {
    content = fulfilled({
      type: "wasm",
      value: action.value.text,
    });
  }

  if (action.source && (action.source.isHTML || action.source.isOriginal)) {
    state.mutableSourceTextContentMapBySourceId.set(action.source.id, content);
  } else if (action.sourceActor) {
    state.mutableSourceTextContentMapBySourceActorId.set(
      action.sourceActor.id,
      content
    );
  } else {
    throw new Error("Either a source or a source actor should exist");
  }

  return {
    ...state,
  };
}

function removeAllSourceTextContentForSourcesAndActors(state, action) {
  if (!action.sources.length && !action.actors.length) {
    return state;
  }
  const sourceTextBySourceIdSizeBefore =
    state.mutableSourceTextContentMapBySourceId.size;
  for (const source of action.sources) {
    state.mutableSourceTextContentMapBySourceId.delete(source.id);
  }
  const sourceTextBySourceActorIdSizeBefore =
    state.mutableSourceTextContentMapBySourceActorId.size;
  for (const actor of action.actors) {
    state.mutableSourceTextContentMapBySourceActorId.delete(actor.id);
  }
  if (
    sourceTextBySourceIdSizeBefore !=
      state.mutableSourceTextContentMapBySourceId.size ||
    sourceTextBySourceActorIdSizeBefore !=
      state.mutableSourceTextContentMapBySourceActorId.size
  ) {
    return { ...state };
  }
  return state;
}

export default update;
