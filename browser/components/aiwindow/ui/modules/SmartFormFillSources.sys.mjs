/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The sources Smart Form Fill draws values from and the dialog where the
 * user picks them.
 */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

/** @typedef {import("moz-src:///browser/components/aiwindow/models/SmartFormFillModel.sys.mjs").TabData} TabData */
/** @typedef {import("moz-src:///browser/components/aiwindow/ui/modules/SmartFormFillController.sys.mjs").SelectedTab} SelectedTab */
/** @typedef {import("moz-src:///browser/components/aiwindow/ui/modules/SmartFormFillTelemetry.sys.mjs").SourceEditorResult} SourceEditorResult */
/** @typedef {import("moz-src:///browser/components/aiwindow/ui/modules/SmartFormFillAutocomplete.sys.mjs").SmartFormFillAutocompleteSource} SmartFormFillAutocompleteSource */

const lazy = XPCOMUtils.declareLazy({
  AutofillDataTypes: "resource://gre/modules/shared/AutofillDataTypes.sys.mjs",
  FormAutofill: "resource://autofill/FormAutofill.sys.mjs",
  formAutofillStorage: "resource://autofill/FormAutofillStorage.sys.mjs",
  FormAutofillUtils: "resource://gre/modules/shared/FormAutofillUtils.sys.mjs",
  GetPageContent: "moz-src:///browser/components/aiwindow/models/Tools.sys.mjs",
  MAX_SELECTED_TABS:
    "chrome://browser/content/aiwindow/modules/SmartFormFillConstants.mjs",
  SOURCE_EDITOR_RESULT:
    "moz-src:///browser/components/aiwindow/ui/modules/SmartFormFillTelemetry.sys.mjs",
  console() {
    return console.createInstance({
      logModule: "SmartFormFillSources",
      maxLogLevelPref: "browser.smartwindow.smartformfill.logLevel",
    });
  },
  maxPageContentLength: {
    pref: "browser.smartwindow.smartformfill.maxPageContentLength",
  },
});

const TAB_SELECTOR_URL =
  "chrome://browser/content/aiwindow/smartformfill-tab-select.html";

export async function getSavedAddresses() {
  if (
    !lazy.FormAutofill.isAutofillTypeEnabled(lazy.AutofillDataTypes.ADDRESS)
  ) {
    return [];
  }

  try {
    await lazy.formAutofillStorage.initialize();
    const addresses = await lazy.formAutofillStorage.addresses.getAll();
    return addresses.sort(
      (a, b) => (b.timeLastUsed ?? 0) - (a.timeLastUsed ?? 0)
    );
  } catch {
    return [];
  }
}

export function getAddressDisplayData(address) {
  const street = lazy.FormAutofillUtils.toOneLineAddress(
    address["street-address"] ?? ""
  );
  const label = address.name || address.organization || address.email;
  return {
    label: label || lazy.FormAutofillUtils.getAddressLabel(address),
    description: label ? street : "",
    favicon: "chrome://browser/skin/fxa/avatar-empty.svg",
  };
}

/**
 * Which sources each form of one Smart Form Fill actor draws from, and the dialog
 * where the user picks them.
 */
export class SmartFormFillTabSelector {
  /** @type {object | null} */
  #dialog = null;

  /**
   * Whether the open dialog was taken away rather than closed by the user,
   * which the two look the same as from the dialog's result alone.
   *
   * @type {boolean}
   */
  #aborted = false;

  /**
   * The tabs the user picked, by form ID, which replace the model's suggestion
   * for that form.
   *
   * @type {Map<string, Array<SelectedTab>>}
   */
  #pickedTabsByFormId = new Map();
  #pickedAddressGuidsByFormId = new Map();

  getSelectedAddress({ id, fields, emptyFieldIds }, addresses) {
    if (this.#pickedAddressGuidsByFormId.has(id)) {
      const guid = this.#pickedAddressGuidsByFormId.get(id);
      return addresses.find(address => address.guid === guid);
    }

    return addresses.find(address =>
      fields.some(
        ({ id: fieldId, localGuess }) =>
          emptyFieldIds.has(fieldId) &&
          localGuess &&
          lazy.FormAutofillUtils.isAddressField(localGuess) &&
          address[localGuess]
      )
    );
  }

  /**
   * @param {string} formId
   * @param {Array<SelectedTab>} suggestedTabs Tabs the model found relevant.
   * @returns {Array<SelectedTab>} The tabs the user picked for the form, or
   *   else the suggested ones.
   */
  getSelectedTabs(formId, suggestedTabs) {
    return (this.#pickedTabsByFormId.get(formId) ?? suggestedTabs).map(
      ({ id }) => ({ id })
    );
  }

  /**
   * @param {string} formId
   * @param {Array<SelectedTab>} suggestedTabs Tabs the model found relevant.
   * @param {Array<TabData>} tabs Every tab that can be a source.
   * @returns {Array<SmartFormFillAutocompleteSource>} Display data for the
   *   selected tabs.
   */
  getSelectedSources(formId, suggestedTabs, tabs) {
    const tabsById = new Map(tabs.map(tab => [tab.id, tab]));
    return this.getSelectedTabs(formId, suggestedTabs)
      .map(({ id }) => tabsById.get(id))
      .filter(Boolean)
      .map(tab => ({
        label: tab.title || tab.url,
        favicon: `page-icon:${tab.url}`,
      }));
  }

  /**
   * @param {string} formId - A form that went away.
   */
  forget(formId) {
    this.#pickedTabsByFormId.delete(formId);
    this.#pickedAddressGuidsByFormId.delete(formId);
  }

  /**
   * Closes the dialog on the user's behalf and forgets every pick, because the
   * tabs they were made from changed.
   */
  reset() {
    if (this.#dialog) {
      this.#aborted = true;
      this.#dialog.abort();
    }
    this.#pickedTabsByFormId.clear();
  }

  /**
   * Opens the dialog for a form, with the suggested tabs listed first, and
   * keeps what the user picks.
   *
   * @param {object} options
   * @param {MozBrowser} options.browser The browser the dialog is modal to.
   * @param {ChromeWindow} options.chromeWindow The window holding the browser.
   * @param {string} options.formId
   * @param {Array<TabData>} options.tabs Every tab the user can pick from.
   * @param {Array<SelectedTab>} options.suggestedTabs Tabs the model found
   *   relevant.
   * @param {Array<object>} options.addresses Saved addresses the user can pick.
   * @param {string | undefined} options.selectedAddressGuid Current address.
   * @param {string} options.pageUrl The page being filled, which is not
   *   offered as its own source.
   * @returns {Promise<SourceEditorResult> | null} How the dialog closed, or
   *   null when it could not open.
   */
  open({
    browser,
    chromeWindow,
    formId,
    tabs,
    suggestedTabs,
    addresses,
    selectedAddressGuid,
    pageUrl,
  }) {
    if (this.#dialog || !browser || !chromeWindow?.gBrowser) {
      return null;
    }

    const selectedTabIds = new Set(
      this.getSelectedTabs(formId, suggestedTabs).map(({ id }) => id)
    );
    const tabsById = new Map(tabs.map(tab => [tab.id, tab]));
    const toDialogTab = tab => ({
      ...tab,
      favicon: `page-icon:${tab.url}`,
      pressed: selectedTabIds.has(tab.id),
    });
    const suggested = suggestedTabs
      .map(({ id }) => tabsById.get(id))
      .filter(Boolean)
      .map(toDialogTab);
    const suggestedIds = new Set(suggested.map(({ id }) => id));
    const others = tabs
      .filter(tab => !suggestedIds.has(tab.id) && tab.url !== pageUrl)
      .map(toDialogTab);
    const selectableIds = new Set([...suggestedIds, ...others.map(t => t.id)]);
    const selectableAddressGuids = new Set(addresses.map(({ guid }) => guid));

    const dialogArguments = {
      suggestedTabs: suggested,
      otherTabs: others,
      savedAddresses: addresses.map(address => ({
        ...getAddressDisplayData(address),
        guid: address.guid,
      })),
      selectedAddressGuid: selectedAddressGuid ?? null,
      result: null,
    };
    const { dialog, closedPromise } = chromeWindow.gBrowser
      .getTabDialogBox(browser)
      .open(
        TAB_SELECTOR_URL,
        { features: "resizable=no", allowDuplicateDialogs: false },
        dialogArguments
      );
    if (!dialog) {
      return null;
    }

    this.#dialog = dialog;
    this.#aborted = false;

    return closedPromise
      .finally(() => {
        if (this.#dialog === dialog) {
          this.#dialog = null;
        }
      })
      .then(() => {
        const { selectedTabIds: ids, selectedAddressGuid: guid } =
          dialogArguments.result ?? {};
        if (
          !Array.isArray(ids) ||
          (!ids.length && !selectableAddressGuids.size) ||
          ids.length > lazy.MAX_SELECTED_TABS ||
          new Set(ids).size !== ids.length ||
          ids.some(id => !selectableIds.has(id)) ||
          (guid !== null && !selectableAddressGuids.has(guid))
        ) {
          return this.#aborted
            ? lazy.SOURCE_EDITOR_RESULT.ABORTED
            : lazy.SOURCE_EDITOR_RESULT.CANCEL;
        }
        this.#pickedTabsByFormId.set(
          formId,
          ids.map(id => ({ id }))
        );
        if (selectableAddressGuids.size) {
          this.#pickedAddressGuidsByFormId.set(formId, guid);
        }
        return lazy.SOURCE_EDITOR_RESULT.DONE;
      });
  }
}

/**
 * Extracts the text of the page being filled and of its source tabs, which
 * share one length budget.
 *
 * @param {WindowGlobalParent} windowGlobal The page being filled.
 * @param {Array<TabData>} tabs The source tabs.
 * @returns {Promise<{pageText: string, tabContentById: Map<string, string>}>}
 */
export async function getSourceTexts(windowGlobal, tabs) {
  const textCharLimit = Math.ceil(
    lazy.maxPageContentLength / (tabs.length + 1)
  );
  const tabContentById = new Map();
  const [pageText] = await Promise.all([
    getPageText(windowGlobal, textCharLimit),
    ...tabs.map(async ({ id, url }) => {
      const tab = lazy.GetPageContent.getTabWithURL(url);
      const tabWindowGlobal =
        tab?.linkedBrowser.browsingContext?.currentWindowGlobal;
      if (tabWindowGlobal) {
        tabContentById.set(
          id,
          await getPageText(tabWindowGlobal, textCharLimit)
        );
      }
    }),
  ]);
  return { pageText, tabContentById };
}

/**
 * @param {WindowGlobalParent} windowGlobal
 * @param {number} textCharLimit
 * @returns {Promise<string>} The page text, or "" when it cannot be extracted.
 */
async function getPageText(windowGlobal, textCharLimit) {
  try {
    const extraction = await windowGlobal.getActor("PageExtractor").getText({
      sufficientLength: textCharLimit,
      removeBoilerplate: true,
      sourceUrl: windowGlobal.documentURI.spec,
    });
    return extraction?.text ?? "";
  } catch (error) {
    if (!windowGlobal.isClosed) {
      lazy.console.error("Could not extract page text", error);
    }
    return "";
  }
}
