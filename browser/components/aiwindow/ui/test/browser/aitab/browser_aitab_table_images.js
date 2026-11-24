/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const TEST_PAGE = new URL(
  "../test_aitab_table_page.html",
  getRootDirectory(gTestPath)
).href;
const ROW_TITLE = "Row title example";
const IMAGE_SRC = "chrome://branding/content/about-logo.png";

describe("When AITab table row support images", () => {
  it("renders an image before the title in the row header", async () => {
    await BrowserTestUtils.withNewTab(TEST_PAGE, async browser => {
      await renderRow(browser, { name: ROW_TITLE, image: { src: IMAGE_SRC } });

      await SpecialPowers.spawn(
        browser,
        [ROW_TITLE, IMAGE_SRC],
        async (title, src) => {
          const table = content.document.getElementById("table");
          const rowHeader = table.shadowRoot.querySelector('th[scope="row"]');
          const image = rowHeader?.querySelector("aitab-image");
          if (!image) {
            throw new Error("The row header did not render an image");
          }
          await image.updateComplete;
          const img = image.shadowRoot.querySelector("img");
          if (!img) {
            throw new Error("aitab-image did not render an img element");
          }
          img.scrollIntoView();
          await ContentTaskUtils.waitForCondition(
            () => img.complete && img.naturalWidth > 0,
            "The row image finishes loading"
          );
          Assert.equal(img.currentSrc, src, "The row image loads");
          Assert.equal(
            image.nextElementSibling?.textContent.trim(),
            title,
            "The title follows the image in the same row header"
          );
        }
      );
    });
  });

  it("renders the row title without an image", async () => {
    await BrowserTestUtils.withNewTab(TEST_PAGE, async browser => {
      await renderRow(browser, { name: ROW_TITLE });

      await SpecialPowers.spawn(browser, [ROW_TITLE], title => {
        const table = content.document.getElementById("table");
        const rowHeader = table.shadowRoot.querySelector('th[scope="row"]');
        if (!rowHeader) {
          throw new Error("The table did not render a row header");
        }
        Assert.equal(
          rowHeader.textContent.trim(),
          title,
          "The row title renders"
        );
        Assert.equal(
          rowHeader.querySelector("aitab-image"),
          null,
          "No image renders"
        );
      });
    });
  });
});

/**
 * Renders one row in the table fixture.
 *
 * @param {MozBrowser} browser - The browser showing the table fixture.
 * @param {object} row - The row title and optional image.
 */
function renderRow(browser, row) {
  return SpecialPowers.spawn(browser, [row], async rowData => {
    await content.customElements.whenDefined("aitab-table");
    const table = content.document.getElementById("table");
    table.columns = [{ key: "name", label: "Name", type: "text", role: "title" }];
    table.rows = [rowData];
    await table.updateComplete;
  });
}
