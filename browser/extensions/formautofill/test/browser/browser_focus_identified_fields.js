/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const TEST_DOCUMENT = `
  <input id="given-name" autocomplete="given-name">
  <input id="family-name" autocomplete="family-name">
  <input id="street-address" autocomplete="street-address">
  <input id="search" type="search">
  <input id="other">
`;

// Focusing fields of a form-less section that was already identified must not
// rebuild a FormLike, because that queries every form control in the document
// (bug 2060023).
add_task(async function test_refocus_does_not_rebuild_formlike() {
  await setStorage(TEST_ADDRESS_1);

  const TEST_URL =
    "https://example.org/document-builder.sjs?html=" +
    encodeURIComponent(TEST_DOCUMENT);
  await BrowserTestUtils.withNewTab(TEST_URL, async browser => {
    await focusAndWaitForFieldsIdentified(browser, "#given-name");

    const createdFormLikes = await SpecialPowers.spawn(browser, [], () => {
      const { AutofillFormFactory } = ChromeUtils.importESModule(
        "resource://gre/modules/shared/AutofillFormFactory.sys.mjs"
      );
      const original = AutofillFormFactory.createFromField;
      let count = 0;
      AutofillFormFactory.createFromField = function (...args) {
        count++;
        return original.apply(this, args);
      };
      try {
        for (const id of ["family-name", "street-address", "given-name"]) {
          content.document.getElementById(id).focus();
        }
      } finally {
        AutofillFormFactory.createFromField = original;
      }
      return count;
    });

    is(
      createdFormLikes,
      0,
      "No FormLike is created when focusing already identified fields"
    );
  });

  await removeAllRecords();
});

function waitForFieldsIdentified() {
  return new Promise(resolve => {
    const observer = {
      fieldsIdentified() {
        FormAutofillParent.removeMessageObserver(observer);
        resolve();
      },
    };
    FormAutofillParent.addMessageObserver(observer);
  });
}

const FORM_DOCUMENT = `
  <form id="form">
    <input id="given-name" autocomplete="given-name">
    <input id="family-name" autocomplete="family-name">
    <input id="street-address" autocomplete="street-address">
  </form>
`;

// A field inserted while the first field detection is still pending must be
// picked up when an already identified field is focused again.
for (const { description, html } of [
  { description: "form-less", html: TEST_DOCUMENT },
  { description: "form-associated", html: FORM_DOCUMENT },
]) {
  add_task(async function test_refocus_detects_field_added_during_detection() {
    info(`Testing ${description} fields`);
    await setStorage(TEST_ADDRESS_1);

    const TEST_URL =
      "https://example.org/document-builder.sjs?html=" +
      encodeURIComponent(html);
    await BrowserTestUtils.withNewTab(TEST_URL, async browser => {
      let fieldsIdentified = waitForFieldsIdentified();
      await SpecialPowers.spawn(browser, [], () => {
        content.document.getElementById("given-name").focus();
        const tel = content.document.createElement("input");
        tel.autocomplete = "tel";
        if (content.document.getElementById("form")) {
          tel.setAttribute("form", "form");
        }
        content.document.body.append(tel);
      });
      await fieldsIdentified;

      fieldsIdentified = waitForFieldsIdentified();
      await SpecialPowers.spawn(browser, [], () => {
        content.document.getElementById("family-name").focus();
      });
      await fieldsIdentified;

      const actor =
        browser.browsingContext.currentWindowGlobal.getActor("FormAutofill");
      const fieldNames = Array.from(actor.sectionsByRootId.values())
        .flat()
        .flatMap(section => section.fieldDetails.map(fd => fd.fieldName));
      Assert.ok(
        fieldNames.includes("tel"),
        `The added field is detected, got ${fieldNames}`
      );
    });

    await removeAllRecords();
  });
}
