/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

const { XPCShellContentUtils } = ChromeUtils.importESModule(
  "resource://testing-common/XPCShellContentUtils.sys.mjs"
);

const PDF_FILE = new FileUtils.File(getTestFilePath("file_pdfjs_test.pdf"));
const PDF_ICON = "chrome://global/skin/icons/pdf.svg";

add_setup(async function () {
  XPCShellContentUtils.ensureInitialized(this);
  await SpecialPowers.pushPrefEnv({
    set: [["browser.chrome.guess_favicon", true]],
  });
});

function getPdfIcon(url) {
  return BrowserTestUtils.withNewTab("about:blank", async browser => {
    await waitForPdfJS(browser, url);
    const tab = gBrowser.getTabForBrowser(browser);
    try {
      return await TestUtils.waitForCondition(
        () => gBrowser.getIcon(tab),
        "The PDF tab gets an icon"
      );
    } finally {
      await waitForPdfJSClose(browser);
    }
  });
}

async function getWebPdfIcon(faviconHandler) {
  const server = XPCShellContentUtils.createHttpServer();
  server.registerFile("/test.pdf", PDF_FILE);
  if (faviconHandler) {
    server.registerPathHandler("/favicon.ico", faviconHandler);
  }
  const origin = `http://localhost:${server.identity.primaryPort}`;
  const faviconURL = origin + "/favicon.ico";
  let loadingOrigin;
  const observer = subject => {
    const channel = subject.QueryInterface(Ci.nsIChannel);
    if (channel.URI.spec == faviconURL) {
      loadingOrigin = channel.loadInfo.loadingPrincipal.originNoSuffix;
    }
  };
  Services.obs.addObserver(observer, "http-on-modify-request");
  try {
    const icon = await getPdfIcon(origin + "/test.pdf");
    return { icon, origin, loadingOrigin };
  } finally {
    Services.obs.removeObserver(observer, "http-on-modify-request");
  }
}

function serveFavicon(_request, response) {
  response.setHeader("Content-Type", "image/svg+xml");
  response.write(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>'
  );
}

add_task(async function test_pdf_with_site_favicon() {
  const { icon, origin, loadingOrigin } = await getWebPdfIcon(serveFavicon);
  Assert.ok(icon.startsWith("data:"), "The PDF tab displays the site favicon");
  Assert.equal(
    loadingOrigin,
    origin,
    "The favicon request uses the PDF's origin"
  );
});

add_task(async function test_pdf_without_site_favicon() {
  const { icon, origin, loadingOrigin } = await getWebPdfIcon();
  Assert.equal(icon, PDF_ICON, "The PDF tab displays the fallback icon");
  Assert.equal(
    loadingOrigin,
    origin,
    "The favicon request uses the PDF's origin"
  );
});

add_task(async function test_pdf_without_favicon_guessing() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.chrome.guess_favicon", false]],
  });
  const { icon, loadingOrigin } = await getWebPdfIcon(serveFavicon);
  Assert.equal(icon, PDF_ICON, "The PDF tab displays the viewer icon");
  Assert.equal(loadingOrigin, undefined, "No favicon request is made");
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_local_pdf() {
  const icon = await getPdfIcon(Services.io.newFileURI(PDF_FILE).spec);
  Assert.equal(icon, PDF_ICON, "The local PDF tab displays the fallback icon");
});
