/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
import {
  html,
  repeat,
  nothing,
} from "chrome://global/content/vendor/lit.all.mjs";
import { MAX_SELECTED_TABS } from "chrome://browser/content/aiwindow/modules/SmartFormFillConstants.mjs";

/**
 * Interface for choosing sources to use in Smart Form Fill
 */
export class AiSffTabSelector extends MozLitElement {
  static properties = {
    suggestedTabs: { type: Array },
    otherTabs: { type: Array },
    savedAddresses: { type: Array },
    selectedAddressGuid: { type: String },
  };

  constructor() {
    super();

    this.suggestedTabs = [];
    this.otherTabs = [];
    this.savedAddresses = [];
    this.selectedAddressGuid = null;
  }

  get #selectedTabIds() {
    return [...this.suggestedTabs, ...this.otherTabs]
      .filter(tab => tab.pressed)
      .map(tab => tab.id);
  }

  #updateTab(tabs, tabId, pressed) {
    return tabs.map(tab => (tab.id === tabId ? { ...tab, pressed } : tab));
  }

  #handleTabToggle(event, tabId) {
    const { pressed } = event.currentTarget;

    this.suggestedTabs = this.#updateTab(this.suggestedTabs, tabId, pressed);
    this.otherTabs = this.#updateTab(this.otherTabs, tabId, pressed);
  }

  #canConfirmSourceSelection(selectedTabCount) {
    return (
      selectedTabCount <= MAX_SELECTED_TABS &&
      (selectedTabCount > 0 || Boolean(this.savedAddresses.length))
    );
  }

  #handleAccept() {
    const selectedTabIds = this.#selectedTabIds;
    if (!this.#canConfirmSourceSelection(selectedTabIds.length)) {
      return;
    }

    this.dispatchEvent(
      new CustomEvent("tabs-selected", {
        bubbles: true,
        composed: true,
        detail: {
          selectedTabIds,
          selectedAddressGuid: this.selectedAddressGuid,
        },
      })
    );
  }

  #handleCancel() {
    this.dispatchEvent(
      new CustomEvent("cancel", {
        bubbles: true,
        composed: true,
      })
    );
  }

  #renderSourceList(heading, className, items) {
    return html`
      <moz-box-group type="list" class=${className}>
        <moz-box-item slot="header">
          <h2 class="tab-selector-list-heading" data-l10n-id=${heading}></h2>
        </moz-box-item>
        ${items}
      </moz-box-group>
    `;
  }

  #renderSavedAddresses() {
    return this.#renderSourceList(
      "ai-smart-form-fill-saved-addresses-heading",
      "tab-selector-tabs-scrollable ai-smart-form-fill-saved-addresses",
      repeat(
        this.savedAddresses,
        address => address.guid,
        address => html`
          <moz-box-item
            .label=${address.label}
            .description=${address.description}
            .iconSrc=${address.favicon}
          >
            <moz-toggle
              slot="actions"
              data-l10n-id="ai-smart-form-fill-address-select-toggle"
              data-l10n-args=${JSON.stringify({
                address: [address.label, address.description]
                  .filter(Boolean)
                  .join(", "),
              })}
              .pressed=${this.selectedAddressGuid === address.guid}
              @toggle=${event => {
                this.selectedAddressGuid = event.currentTarget.pressed
                  ? address.guid
                  : null;
              }}
            ></moz-toggle>
          </moz-box-item>
        `
      )
    );
  }

  #renderTabList(tabLabelFluentId, tabs, selectedTabCount, scrollable = false) {
    return this.#renderSourceList(
      tabLabelFluentId,
      scrollable
        ? "tab-selector-tabs-scrollable ai-smart-form-fill-other-tabs"
        : "ai-smart-form-fill-suggested-tabs",
      repeat(
        tabs,
        tab => tab.id,
        tab => html`
          <moz-box-item
            .label=${tab.title || tab.url}
            .description=${tab.url}
            .iconSrc=${tab.favicon}
          >
            <moz-toggle
              slot="actions"
              data-l10n-id="ai-smart-form-fill-tab-select-toggle"
              data-l10n-args=${JSON.stringify({
                tabTitle: tab.title,
              })}
              .pressed=${tab.pressed}
              .disabled=${selectedTabCount >= MAX_SELECTED_TABS && !tab.pressed}
              @toggle=${event => this.#handleTabToggle(event, tab.id)}
            ></moz-toggle>
          </moz-box-item>
        `
      )
    );
  }

  render() {
    const selectedTabCount = this.#selectedTabIds.length;

    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/aiwindow/components/ai-sff-tab-selector.css"
      />

      <div class="tab-selector-dialog">
        <h1
          class="tab-selector-title"
          data-l10n-id="ai-smart-form-fill-edit-sources-title"
        ></h1>

        ${this.savedAddresses.length ? this.#renderSavedAddresses() : nothing}
        ${this.suggestedTabs?.length
          ? this.#renderTabList(
              "ai-smart-form-fill-suggested-tabs-heading",
              this.suggestedTabs,
              selectedTabCount
            )
          : nothing}
        ${this.otherTabs?.length
          ? this.#renderTabList(
              "ai-smart-form-fill-other-tabs-heading",
              this.otherTabs,
              selectedTabCount,
              true
            )
          : nothing}

        <moz-button-group class="tab-selector-actions">
          <moz-button
            data-l10n-id="ai-smart-form-fill-cancel-tab-select-button"
            size="large"
            @click=${this.#handleCancel}
          ></moz-button>
          <moz-button
            data-l10n-id="ai-smart-form-fill-accept-tab-select-button"
            type="primary"
            size="large"
            .disabled=${!this.#canConfirmSourceSelection(selectedTabCount)}
            @click=${this.#handleAccept}
          ></moz-button>
        </moz-button-group>
      </div>
    `;
  }
}

customElements.define("ai-sff-tab-selector", AiSffTabSelector);
