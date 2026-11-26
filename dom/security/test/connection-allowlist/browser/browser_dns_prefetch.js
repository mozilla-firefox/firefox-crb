"use strict";

const TEST_PATH = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com"
);

const ALLOWED = "127.0.0.1";
const BLOCKED = "127.0.0.4";
// Allowed by "http://127.0.0.5:8080/", and prefetched last so we know when the
// other prefetches have been handled.
const LAST = "127.0.0.5";

// Only the host of a dns-prefetch is matched against the hostname component of
// the allowlist patterns "https://127.0.0.1/some/path" and
// "http://127.0.0.5:8080/", so the scheme, port and path of both don't matter.
const HREFS = [
  `https://${ALLOWED}/`,
  `https://${BLOCKED}/`,
  `https://${LAST}/`,
];

// Resolves with the hosts of every DNS resolution seen until the one of LAST.
function waitForResolutions() {
  const seen = [];
  return new Promise(resolve => {
    const observer = {
      QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
      observe(aSubject, aTopic, aData) {
        info(`DNS resolution: ${aData}`);
        seen.push(aData);
        if (aData == LAST) {
          Services.obs.removeObserver(observer, "dns-resolution-request");
          resolve(seen);
        }
      },
    };
    Services.obs.addObserver(observer, "dns-resolution-request");
  });
}

// Adds <link rel=dns-prefetch> elements for HREFS in order. Resolves with the
// hosts of every DNS resolution seen until the one of LAST, and the first
// batch of Connection-Allowlist reports.
async function dnsPrefetch(browser) {
  const resolutions = waitForResolutions();

  const reports = await SpecialPowers.spawn(browser, [HREFS], aHrefs => {
    const reportsPromise = new Promise(resolve => {
      const observer = new content.ReportingObserver(
        aReports => {
          observer.disconnect();
          resolve(JSON.stringify(aReports));
        },
        { types: ["connection-allowlist"] }
      );
      observer.observe();
    });

    for (const href of aHrefs) {
      const link = content.document.createElement("link");
      link.rel = "dns-prefetch";
      link.href = href;
      content.document.head.appendChild(link);
    }

    return reportsPromise;
  });

  return { seen: await resolutions, reports: JSON.parse(reports) };
}

function checkReport(reports, disposition) {
  is(reports.length, 1, "Only the not-allow-listed host is reported");
  const { type, body } = reports[0];
  is(type, "connection-allowlist", "Report type");
  is(
    body.url,
    TEST_PATH +
      `file_dns_prefetch${disposition == "report" ? "_report_only" : ""}.html`,
    "Report url"
  );
  is(body.connection, BLOCKED, "The reported connection is the host");
  Assert.deepEqual(
    body.allowlist,
    // eslint-disable-next-line sdl/no-insecure-url
    [`https://${ALLOWED}/some/path`, `http://${LAST}:8080/`],
    "Report allowlist"
  );
  is(body.disposition, disposition, "Report disposition");
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["network.dns.notifyResolution", true],
      // The mochitest proxy would otherwise disable DNS prefetching.
      ["network.dns.prefetch_via_proxy", true],
    ],
  });

  const dns = Services.dns.QueryInterface(Ci.nsPIDNSService);
  const prefetchEnabled = dns.prefetchEnabled;
  dns.prefetchEnabled = true;
  registerCleanupFunction(() => {
    dns.prefetchEnabled = prefetchEnabled;
  });
});

add_task(async function test_enforce() {
  await BrowserTestUtils.withNewTab(
    TEST_PATH + "file_dns_prefetch.html",
    async browser => {
      const { seen, reports } = await dnsPrefetch(browser);
      ok(seen.includes(ALLOWED), `Resolved the allowed host, saw ${seen}`);
      ok(
        !seen.includes(BLOCKED),
        `Didn't resolve the blocked host, saw ${seen}`
      );
      checkReport(reports, "enforce");
    }
  );
});

add_task(async function test_report_only() {
  await BrowserTestUtils.withNewTab(
    TEST_PATH + "file_dns_prefetch_report_only.html",
    async browser => {
      const { seen, reports } = await dnsPrefetch(browser);
      ok(seen.includes(ALLOWED), `Resolved the allowed host, saw ${seen}`);
      ok(seen.includes(BLOCKED), `Report-only does not block, saw ${seen}`);
      checkReport(reports, "report");
    }
  );
});

add_task(async function test_link_header() {
  const resolutions = waitForResolutions();
  await BrowserTestUtils.withNewTab(
    TEST_PATH + "file_dns_prefetch_link_header.html",
    async () => {
      const seen = await resolutions;
      ok(seen.includes(ALLOWED), `Resolved the allowed host, saw ${seen}`);
      ok(
        !seen.includes(BLOCKED),
        `Didn't resolve the blocked host, saw ${seen}`
      );
    }
  );
});
