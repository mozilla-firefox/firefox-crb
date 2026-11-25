/*
 This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @typedef ConversationStatus
 * @property {number} ACTIVE - An active conversation
 * @property {number} ARCHIVE - An archived conversation
 * @property {number} DELETED - A deleted conversation
 */

/**
 * @type {ConversationStatus}
 */
export const CONVERSATION_STATUS = Object.freeze({
  ACTIVE: 0,
  ARCHIVED: 1,
  DELETED: 2,
});

export { MESSAGE_ROLE } from "moz-src:///browser/components/aiwindow/models/Conversation.sys.mjs";

/**
 * @typedef {0 | 1 | 2} ToolResultType
 */

/**
 * Type of tool call result data.
 *
 * @type {ToolResultType}
 */
export const TOOL_RESULT_TYPE = Object.freeze({
  TOOL_UI: 0,
  HISTORY_RESULTS: 1,
  CITATIONS: 2,
});

/**
 * UI labels for tool results and follow-ups.
 */
export const UI_TYPES = {
  AITAB: "aitab",
  WEBSITE_CONFIRMATION: "website-confirmation",
  TAB_GROUP_CONFIRMATION: "tab-group-confirmation",
  AI_ACTION_RESULT: "ai-action-result",
  CANCELLED_COMPONENT: "cancelled-component",
  RETRY_COMPONENT: "retry-component",
};

/**
 * UI types that represent confirmation dialogs with stateful behavior
 * These UIs can be cancelled and need special handling when restored from DB
 */
export const CONFIRMATION_UI_TYPES = [
  UI_TYPES.WEBSITE_CONFIRMATION,
  UI_TYPES.TAB_GROUP_CONFIRMATION,
];

/**
 * @typedef {0 | 1 | 2} MemoriesFlagSource
 */

/**
 * @type {MemoriesFlagSource}
 */
export const MEMORIES_FLAG_SOURCE = Object.freeze({
  GLOBAL: 0,
  CONVERSATION: 1,
  MESSAGE_ONCE: 2,
});

/**
 * @typedef { "text" | "injected_memories" | "injected_real_time_info" } SystemPromptType
 */

/**
 * @type {SystemPromptType}
 */
export const SYSTEM_PROMPT_TYPE = Object.freeze({
  TEXT: "text",
  MEMORIES: "injected_memories",
  REAL_TIME: "injected_real_time_info",
});
