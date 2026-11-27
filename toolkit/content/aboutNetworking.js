/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const FileUtils = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
).FileUtils;
const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PrivateBrowsingUtils.sys.mjs"
);
const gDashboard = Cc["@mozilla.org/network/dashboard;1"].getService(
  Ci.nsIDashboard
);
const gDirServ = Cc["@mozilla.org/file/directory_service;1"].getService(
  Ci.nsIDirectoryServiceProvider
);
const gNetLinkSvc =
  Cc["@mozilla.org/network/network-link-service;1"] &&
  Cc["@mozilla.org/network/network-link-service;1"].getService(
    Ci.nsINetworkLinkService
  );
const gCertDB = Cc["@mozilla.org/security/x509certdb;1"].getService(
  Ci.nsIX509CertDB
);

const gRequestNetworkingData = {
  http: gDashboard.requestHttpConnections,
  sockets: gDashboard.requestSockets,
  dns: gDashboard.requestDNSInfo,
  websockets: gDashboard.requestWebsocketConnections,
  altsvc: gDashboard.requestAltSvcCache,
  ssltokens: gDashboard.requestSSLTokensCache,
  dnslookuptool: () => {},
  networkid: displayNetworkID,
};
const gDashboardCallbacks = {
  http: displayHttp,
  sockets: displaySockets,
  dns: displayDns,
  websockets: displayWebsockets,
  altsvc: displayAltSvc,
  ssltokens: displaySSLTokensCache,
};

const REFRESH_INTERVAL_MS = 3000;

const gIsPrivateBrowsing = PrivateBrowsingUtils.isWindowPrivate(window);

function isPrivateBrowsingEntry(originAttributesSuffix) {
  return !!ChromeUtils.CreateOriginAttributesFromOriginSuffix(
    originAttributesSuffix
  ).privateBrowsingId;
}

function col(element) {
  let col = document.createElement("td");
  let content = document.createTextNode(element);
  col.appendChild(content);
  return col;
}

function displayHttp(data) {
  let cont = document.getElementById("http_content");
  let parent = cont.parentNode;
  let new_cont = document.createElement("tbody");
  new_cont.setAttribute("id", "http_content");

  for (let i = 0; i < data.connections.length; i++) {
    if (
      !gIsPrivateBrowsing &&
      isPrivateBrowsingEntry(data.connections[i].originAttributesSuffix)
    ) {
      continue;
    }
    let row = document.createElement("tr");
    row.appendChild(col(data.connections[i].host));
    row.appendChild(col(data.connections[i].port));
    row.appendChild(col(data.connections[i].httpVersion));
    row.appendChild(col(data.connections[i].ssl));
    row.appendChild(col(data.connections[i].active.length));
    row.appendChild(col(data.connections[i].idle.length));
    row.appendChild(col(data.connections[i].originAttributesSuffix));
    new_cont.appendChild(row);
  }

  parent.replaceChild(new_cont, cont);
}

function displaySockets(data) {
  let cont = document.getElementById("sockets_content");
  let parent = cont.parentNode;
  let new_cont = document.createElement("tbody");
  new_cont.setAttribute("id", "sockets_content");

  for (let i = 0; i < data.sockets.length; i++) {
    if (
      !gIsPrivateBrowsing &&
      isPrivateBrowsingEntry(data.sockets[i].originAttributesSuffix)
    ) {
      continue;
    }
    let row = document.createElement("tr");
    row.appendChild(col(data.sockets[i].host));
    row.appendChild(col(data.sockets[i].port));
    row.appendChild(col(data.sockets[i].type));
    row.appendChild(col(data.sockets[i].active));
    row.appendChild(col(data.sockets[i].sent));
    row.appendChild(col(data.sockets[i].received));
    row.appendChild(col(data.sockets[i].originAttributesSuffix));
    new_cont.appendChild(row);
  }

  parent.replaceChild(new_cont, cont);
}

function displayDns(data) {
  let suffixContent = document.getElementById("dns_suffix_content");
  let suffixParent = suffixContent.parentNode;
  let suffixes = [];
  try {
    suffixes = gNetLinkSvc.dnsSuffixList; // May throw
  } catch (e) {}
  let suffix_tbody = document.createElement("tbody");
  suffix_tbody.id = "dns_suffix_content";
  for (let suffix of suffixes) {
    let row = document.createElement("tr");
    row.appendChild(col(suffix));
    suffix_tbody.appendChild(row);
  }
  suffixParent.replaceChild(suffix_tbody, suffixContent);

  let trr_url_tbody = document.createElement("tbody");
  trr_url_tbody.id = "dns_trr_url";
  let trr_url = document.createElement("tr");
  let current_trr_uri = Services.dns.currentTrrURI;
  let current_trr_mode = Services.dns.currentTrrMode;
  switch (current_trr_mode) {
    case Ci.nsIDNSService.MODE_NATIVEONLY:
    case Ci.nsIDNSService.MODE_TRROFF:
      current_trr_mode = "Off";
      current_trr_uri = "";
      break;
    case Ci.nsIDNSService.MODE_TRRFIRST:
      current_trr_mode = "TRR first";
      break;
    case Ci.nsIDNSService.MODE_TRRONLY:
      current_trr_mode = "TRR only";
      break;
    default:
      break;
  }
  trr_url.appendChild(col(current_trr_uri));
  trr_url.appendChild(col(current_trr_mode));
  trr_url_tbody.appendChild(trr_url);
  let prevURL = document.getElementById("dns_trr_url");
  prevURL.parentNode.replaceChild(trr_url_tbody, prevURL);

  let cont = document.getElementById("dns_content");
  let parent = cont.parentNode;
  let new_cont = document.createElement("tbody");
  new_cont.setAttribute("id", "dns_content");

  for (let i = 0; i < data.entries.length; i++) {
    // TODO: Will be supported in bug 1889387.
    if (data.entries[i].type != Ci.nsIDNSService.RESOLVE_TYPE_DEFAULT) {
      continue;
    }
    if (
      !gIsPrivateBrowsing &&
      isPrivateBrowsingEntry(data.entries[i].originAttributesSuffix)
    ) {
      continue;
    }

    let row = document.createElement("tr");
    row.appendChild(col(data.entries[i].hostname));
    row.appendChild(col(data.entries[i].family));
    row.appendChild(col(data.entries[i].trr));
    let column = document.createElement("td");

    for (let j = 0; j < data.entries[i].hostaddr.length; j++) {
      column.appendChild(document.createTextNode(data.entries[i].hostaddr[j]));
      column.appendChild(document.createElement("br"));
    }

    row.appendChild(column);
    row.appendChild(col(data.entries[i].expiration));
    row.appendChild(col(data.entries[i].originAttributesSuffix));
    row.appendChild(col(data.entries[i].flags));
    new_cont.appendChild(row);
  }

  parent.replaceChild(new_cont, cont);
}

function displayWebsockets(data) {
  let cont = document.getElementById("websockets_content");
  let parent = cont.parentNode;
  let new_cont = document.createElement("tbody");
  new_cont.setAttribute("id", "websockets_content");

  for (let i = 0; i < data.websockets.length; i++) {
    let row = document.createElement("tr");
    row.appendChild(col(data.websockets[i].hostport));
    row.appendChild(col(data.websockets[i].encrypted));
    row.appendChild(col(data.websockets[i].msgsent));
    row.appendChild(col(data.websockets[i].msgreceived));
    row.appendChild(col(data.websockets[i].sentsize));
    row.appendChild(col(data.websockets[i].receivedsize));
    new_cont.appendChild(row);
  }

  parent.replaceChild(new_cont, cont);
}

function formatTTL(seconds) {
  if (seconds <= 0) {
    return "expired";
  }
  let parts = [];
  let d = Math.floor(seconds / 86400);
  if (d) {
    parts.push(`${d}d`);
  }
  let h = Math.floor((seconds % 86400) / 3600);
  if (h) {
    parts.push(`${h}h`);
  }
  let m = Math.floor((seconds % 3600) / 60);
  if (m) {
    parts.push(`${m}m`);
  }
  let s = seconds % 60;
  if (s || !parts.length) {
    parts.push(`${s}s`);
  }
  return parts.join(" ");
}

function displayAltSvc(data) {
  let cont = document.getElementById("altsvc_content");
  let parent = cont.parentNode;
  let new_cont = document.createElement("tbody");
  new_cont.setAttribute("id", "altsvc_content");

  for (let i = 0; i < data.entries.length; i++) {
    let entry = data.entries[i];
    if (
      !gIsPrivateBrowsing &&
      isPrivateBrowsingEntry(entry.originAttributesSuffix)
    ) {
      continue;
    }
    let row = document.createElement("tr");
    let scheme = entry.https ? "https" : "http";
    row.appendChild(col(`${scheme}://${entry.originHost}:${entry.originPort}`));
    row.appendChild(col(`${entry.alternateHost}:${entry.alternatePort}`));
    row.appendChild(col(entry.alpn));
    row.appendChild(col(entry.validated));
    row.appendChild(col(formatTTL(entry.ttl)));
    row.appendChild(col(entry.originAttributesSuffix));
    new_cont.appendChild(row);
  }

  parent.replaceChild(new_cont, cont);
}

// Sort orders by table kind ({ column, ascending }), shared by all tables of a
// kind and kept when they are rebuilt.
const gTableSortOrders = new Map();
const gTableSortCollator = new Intl.Collator(undefined, { numeric: true });

// Turns the header cells of a table into buttons that sort its row groups if
// `groups` is true, or else the rows of its <tbody>. A row group sorts by its
// first row, and a cell by its data-sort-value or else its text. Unnamed
// columns don't sort. Tables start sorted by their first named column,
// ascending.
function makeTableSortable(table, kind, groups = false) {
  table.dataset.sortKind = kind;
  let named = table.tHead.querySelectorAll("th[data-l10n-id]");
  if (!gTableSortOrders.has(kind)) {
    gTableSortOrders.set(kind, { column: named[0].cellIndex, ascending: true });
  }
  if (groups) {
    table.dataset.sortGroups = "";
  }
  for (let th of named) {
    let button = createLocalizedElement(
      "button",
      "sort-button",
      th.getAttribute("data-l10n-id")
    );
    th.removeAttribute("data-l10n-id");
    th.setAttribute("aria-sort", "none");
    th.replaceChildren(button);
  }
  sortTable(table);
}

function sortTable(table) {
  let order = gTableSortOrders.get(table.dataset.sortKind);
  if (!order) {
    return;
  }
  let sort = order.ascending ? "ascending" : "descending";
  for (let th of table.tHead.querySelectorAll("th[aria-sort]")) {
    th.setAttribute("aria-sort", th.cellIndex == order.column ? sort : "none");
  }
  if (!table.tBodies.length) {
    return;
  }
  let groups = "sortGroups" in table.dataset;
  let parent = groups ? table : table.tBodies[0];
  let units = groups ? [...table.tBodies] : [...table.tBodies[0].rows];
  let value = unit => {
    let cell = (groups ? unit.rows[0] : unit).cells[order.column];
    return cell?.dataset.sortValue ?? cell?.textContent ?? "";
  };
  let direction = order.ascending ? 1 : -1;
  units.sort(
    (a, b) => direction * gTableSortCollator.compare(value(a), value(b))
  );
  parent.append(...units);
}

function sortTableOnHeaderClick(event) {
  let button = event.target.closest(".sort-button");
  if (!button) {
    return;
  }
  let kind = button.closest("table").dataset.sortKind;
  let column = button.parentElement.cellIndex;
  let order = gTableSortOrders.get(kind);
  gTableSortOrders.set(kind, {
    column,
    ascending: order?.column == column ? !order.ascending : true,
  });
  for (let table of document.querySelectorAll(
    `table[data-sort-kind="${kind}"]`
  )) {
    sortTable(table);
  }
}

// A link that looks the host up on the DNS Lookup tab.
function createDNSLookupLink(host) {
  let link = document.createElement("a");
  link.className = "dns-lookup-link";
  link.href = "#dnslookuptool";
  link.textContent = host;
  return link;
}

function createLocalizedElement(tagName, className, l10nId, args) {
  let element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  document.l10n.setAttributes(element, l10nId, args);
  return element;
}

function lookUpLinkedHost(event) {
  let link = event.target.closest(".dns-lookup-link");
  if (!link) {
    return;
  }
  event.preventDefault();
  document.getElementById("host").value = link.textContent;
  show(document.getElementById("category-dnslookuptool"));
  doLookup();
}

function splitSSLTokensCacheKey(key) {
  let caretIndex = key.indexOf("^");
  return caretIndex < 0
    ? { peerId: key, isolationKey: "" }
    : { peerId: key.slice(0, caretIndex), isolationKey: key.slice(caretIndex) };
}

// Multiple tickets are often issued for the same host in one handshake and
// carry identical metadata apart from the token itself; group them so the
// table shows one row per distinct (host, cert) combination.
function sslTokensGroupKey(entry) {
  return JSON.stringify([
    entry.key,
    entry.evStatus,
    entry.certificateTransparencyStatus,
    entry.overridableErrorCategory,
    entry.builtInRoot,
    entry.succeededHashes,
    entry.handshakeHashes,
  ]);
}

function sslTokensCompressionSavedPercent(
  compressedLength,
  decompressedLength
) {
  return decompressedLength
    ? Math.round(100 * (1 - compressedLength / decompressedLength))
    : null;
}

// Sums the length fields used throughout the SSL tokens UI, e.g. across a
// group's tokens or across the whole cache, and the space saved by compression.
function sumSSLTokensLengths(entries) {
  let totalToken = 0;
  let totalCompressed = 0;
  let totalDecompressed = 0;
  for (let entry of entries) {
    totalToken += entry.tokenLength;
    totalCompressed += entry.compressedLength;
    totalDecompressed += entry.decompressedLength;
  }
  return {
    totalToken,
    totalCompressed,
    totalDecompressed,
    saved: sslTokensCompressionSavedPercent(totalCompressed, totalDecompressed),
  };
}

// The hashes of an entry's certs, one per reference, as the cache counts them.
function sslTokensEntryCertHashes(entry) {
  return [...(entry.succeededHashes ?? []), ...(entry.handshakeHashes ?? [])];
}

// prTime is a PRTime (microseconds since the Unix epoch).
function prTimeToDate(prTime) {
  return new Date(prTime / 1000);
}

function isDateExpired(date) {
  return date.getTime() <= Date.now();
}

function isSSLTokensEntryExpired(entry) {
  return isDateExpired(prTimeToDate(entry.expirationTime));
}

function isSSLTokensEntryShown(entry) {
  let { isolationKey } = splitSSLTokensCacheKey(entry.key);
  return gIsPrivateBrowsing || !isPrivateBrowsingEntry(isolationKey);
}

// A "N% saved" cell with the byte counts in a tooltip, or an empty cell if the
// entry's payload didn't decode.
function buildSSLTokensCompressionCell(entry) {
  let td = document.createElement("td");
  let { tokenLength, decompressedLength, compressedLength } = entry;
  let saved = sslTokensCompressionSavedPercent(
    compressedLength,
    decompressedLength
  );
  if (saved === null) {
    return td;
  }
  td.textContent = `${saved}%`;
  document.l10n.setAttributes(
    td,
    "about-networking-ssl-tokens-compression-details",
    { tokenLength, decompressedLength, compressedLength }
  );
  return td;
}

function addSSLTokensFlagItem(ul, labelL10nId, value) {
  let li = document.createElement("li");
  let label = document.createElement("span");
  document.l10n.setAttributes(label, labelL10nId);
  li.appendChild(label);
  li.appendChild(document.createTextNode(`: ${value}`));
  ul.appendChild(li);
}

// <details> elements are rebuilt from scratch on every refresh, which would
// otherwise reset any collapsible the user had opened; restore prior state
// by group key instead.
function createSSLTokensDetails(groupKey, openKeys) {
  let details = document.createElement("details");
  details.dataset.tokenKey = groupKey;
  if (openKeys.has(groupKey)) {
    details.open = true;
  }
  return details;
}

// certDB.constructX509 takes ownership of neither its input nor output;
// failures (e.g. malformed DER) are reported as gSSLTokensNoCertInfo.
// Keyed by the cert's hash, since the same cert is kept across refreshes.
const gSSLTokensCertInfoCache = new Map();
const gSSLTokensNoCertInfo = {
  subject: "",
  displayName: "",
  issuer: "",
  notAfter: null,
};

// Full DN strings (e.g. "CN=example.com,O=Example Inc,C=US") are noisy, so
// callers show displayName and leave the subject for a tooltip.
function sslTokensCertInfo(cert) {
  if (!cert) {
    return gSSLTokensNoCertInfo;
  }
  if (gSSLTokensCertInfoCache.has(cert.hash)) {
    return gSSLTokensCertInfoCache.get(cert.hash);
  }
  let info;
  try {
    let x509 = gCertDB.constructX509(cert.der);
    info = {
      subject: x509.subjectName,
      displayName: x509.displayName,
      issuer: x509.issuerCommonName || x509.issuerName,
      notAfter: prTimeToDate(x509.validity.notAfter),
    };
  } catch (e) {
    info = gSSLTokensNoCertInfo;
  }
  gSSLTokensCertInfoCache.set(cert.hash, info);
  return info;
}

// Labels an element with a cert's display name, or its hash if the cert is
// missing or can't be parsed, with its subject in a tooltip.
function setSSLTokensCertLabel(element, hash, cert) {
  let { subject, displayName } = sslTokensCertInfo(cert);
  element.textContent = displayName || hash;
  element.title = subject;
}

function sslTokensCertRowId(hash) {
  return `cert-${hash}`;
}

// A link to a cert's row in the certs table.
function createSSLTokensCertLink(hash, certsByHash) {
  let link = document.createElement("a");
  link.className = "ssltokens-cert-link";
  link.href = `#${sslTokensCertRowId(hash)}`;
  setSSLTokensCertLabel(link, hash, certsByHash.get(hash));
  return link;
}

// Scrolls to a cert's row without changing location.hash, which selects the
// category.
function showLinkedSSLTokensCert(event) {
  let link = event.target.closest(".ssltokens-cert-link");
  if (!link) {
    return;
  }
  event.preventDefault();
  link.closest("[popover]")?.hidePopover();
  document.getElementById(link.hash.slice(1))?.scrollIntoView();
}

// The button the popover was last shown for.
let gSSLTokensPopoverSource = null;

function isSSLTokensPopoverOpenFor(button) {
  let popover = document.getElementById("ssltokens_popover");
  return popover.matches(":popover-open") && gSSLTokensPopoverSource == button;
}

// One popover is shared by all buttons; each fills it when pressed, since
// building one per button would add three per row group. Pressing the button
// it is open for closes it.
function addSSLTokensPopoverButton(parent, l10nId, args, fillList) {
  let button = createLocalizedElement("moz-button", "", l10nId, args);
  button.size = "small";
  // A click outside the popover closes it before the click event, so check
  // whether it was open for this button when the click began.
  let wasOpen = false;
  button.addEventListener("pointerdown", () => {
    wasOpen = isSSLTokensPopoverOpenFor(button);
  });
  button.addEventListener("click", event => {
    let popover = document.getElementById("ssltokens_popover");
    let open = popover.matches(":popover-open");
    // A keyboard click has no pointerdown.
    let close = event.detail ? wasOpen : isSSLTokensPopoverOpenFor(button);
    wasOpen = false;
    if (open) {
      popover.hidePopover();
    }
    if (close) {
      return;
    }
    let ul = document.createElement("ul");
    fillList(ul);
    popover.replaceChildren(ul);
    gSSLTokensPopoverSource = button;
    // Showing it again for another button in the same task keeps the old
    // anchor, so wait a frame.
    let show = () => popover.showPopover({ source: button });
    if (open) {
      requestAnimationFrame(show);
    } else {
      show();
    }
  });
  parent.appendChild(button);
}

function addSSLTokensCertListItems(ul, hashes, certsByHash) {
  for (let hash of hashes) {
    let li = document.createElement("li");
    li.appendChild(createSSLTokensCertLink(hash, certsByHash));
    ul.appendChild(li);
  }
}

function addSSLTokensIcon(parent, iconSrc, labelL10nId) {
  let icon = document.createElement("img");
  icon.className = "ssltokens-icon";
  icon.src = iconSrc;
  document.l10n.setAttributes(icon, labelL10nId);
  parent.appendChild(icon);
  return icon;
}

function addSSLTokensRestoredIcon(parent) {
  addSSLTokensIcon(
    parent,
    "chrome://global/skin/icons/arrow-counterclockwise-16.svg",
    "about-networking-ssl-tokens-restored"
  );
}

function addSSLTokensExpiredIcon(td) {
  addSSLTokensIcon(
    td,
    "chrome://global/skin/icons/warning.svg",
    "about-networking-ssl-tokens-expired"
  ).classList.add("ssltokens-icon-expired");
}

function buildSSLTokensHostCell(peerId) {
  let td = document.createElement("td");
  td.className = "ssltokens-key";
  // See NSSSocketControl::GetPeerId: flag prefixes, then host and port.
  let match = peerId.match(
    /^((?:anon:|private:|beConservative:)*(?:tlsflags0x[0-9a-f]{8}:)?)(.+):(\d+)$/
  );
  if (!match) {
    td.textContent = peerId;
    return td;
  }
  let [, prefix, hostname, port] = match;
  td.append(prefix, createDNSLookupLink(hostname), `:${port}`);
  td.dataset.sortValue = hostname;
  return td;
}

// The isolation key is a leading "^" (see OriginAttributes::CreateSuffix)
// followed by a "&"-joined, URL-encoded key=value list; partitionKey is by
// far the most common attribute, so drop its redundant label.
function formatSSLTokensIsolationKey(isolationKey) {
  if (!isolationKey) {
    return "";
  }
  let params = new URLSearchParams(isolationKey.slice(1));
  let parts = [];
  for (let [key, value] of params) {
    parts.push(key == "partitionKey" ? value : `${key}=${value}`);
  }
  return parts.join(" ");
}

function buildSSLTokensIsolationKeyCell(isolationKey) {
  let td = document.createElement("td");
  td.className = "ssltokens-key";
  td.textContent = formatSSLTokensIsolationKey(isolationKey);
  td.title = isolationKey;
  return td;
}

// ISO 8601 in UTC, without milliseconds, so it also sorts as text. Empty if
// there is no date.
function buildSSLTokensDateCell(date) {
  return col(date?.toISOString().replace(/\.\d+Z$/, "Z") ?? "");
}

// Short labels of the HTTP versions' ALPN protocol IDs. Each label, in lower
// case, is also the kind that colors its tokens; tokens with any other ALPN, or
// none, are of kind "other".
const gSSLTokensHTTPVersions = new Map([
  ["h3", "H3"],
  ["h2", "H2"],
  ["http/1.1", "H1"],
]);

function sslTokensProtocolLabel(alpn) {
  return gSSLTokensHTTPVersions.get(alpn) ?? alpn;
}

function sslTokensProtocolKind(alpn) {
  return gSSLTokensHTTPVersions.get(alpn)?.toLowerCase() ?? "other";
}

function createSSLTokensProtocolBadge(alpn) {
  let badge = document.createElement("moz-badge");
  badge.className = `ssltokens-protocol-badge ssltokens-kind-${sslTokensProtocolKind(alpn)}`;
  badge.label = sslTokensProtocolLabel(alpn);
  return badge;
}

// Badges for the ALPNs of some tokens, in label order; null if no token records
// an ALPN.
function buildSSLTokensProtocolBadges(entries) {
  let alpns = [...new Set(entries.map(entry => entry.alpn).filter(Boolean))];
  if (!alpns.length) {
    return null;
  }
  let container = document.createElement("span");
  container.className = "ssltokens-protocol-badges";
  alpns.sort((a, b) =>
    gTableSortCollator.compare(
      sslTokensProtocolLabel(a),
      sslTokensProtocolLabel(b)
    )
  );
  for (let alpn of alpns) {
    container.appendChild(createSSLTokensProtocolBadge(alpn));
  }
  return container;
}

// An ALPN badge, or why there is none. A decoded payload always holds the
// token, so a zero decompressedLength means the payload didn't decode.
function buildSSLTokensProtocolCell(entry) {
  if (entry.alpn) {
    let td = document.createElement("td");
    td.appendChild(createSSLTokensProtocolBadge(entry.alpn));
    return td;
  }
  let l10nId = "about-networking-ssl-tokens-protocol-none";
  if (entry.alpn === undefined) {
    l10nId = entry.decompressedLength
      ? "about-networking-ssl-tokens-protocol-unknown"
      : "about-networking-ssl-tokens-protocol-not-decoded";
  }
  return createLocalizedElement("td", "", l10nId);
}

function buildSSLTokensTokenRow(entry) {
  let row = document.createElement("tr");
  let expires = prTimeToDate(entry.expirationTime);

  let icons = document.createElement("td");
  icons.className = "ssltokens-icons";
  if (entry.restored) {
    addSSLTokensRestoredIcon(icons);
  }
  if (isDateExpired(expires)) {
    addSSLTokensExpiredIcon(icons);
    row.dataset.expired = "";
  }
  row.appendChild(icons);

  let token = col(`#${entry.tokenId}`);
  token.dataset.sortValue = entry.tokenId;
  row.appendChild(token);

  row.appendChild(buildSSLTokensProtocolCell(entry));

  row.appendChild(buildSSLTokensDateCell(expires));
  row.appendChild(buildSSLTokensCompressionCell(entry));
  return row;
}

function buildSSLTokensTokenTable(group) {
  let table = document.createElement("table");
  table.className = "ssltokens-token-table";
  let header = table.createTHead().insertRow();
  // The restored and expired icons get an unnamed column of their own.
  header.appendChild(document.createElement("th")).className =
    "ssltokens-icons";
  for (let l10nId of [
    "about-networking-ssl-tokens-token-column",
    "about-networking-ssl-tokens-protocol-column",
    "about-networking-ssl-tokens-expires",
    "about-networking-ssl-tokens-compression-column",
  ]) {
    header.appendChild(createLocalizedElement("th", "", l10nId));
  }
  let tbody = table.createTBody();
  for (let entry of group) {
    tbody.appendChild(buildSSLTokensTokenRow(entry));
  }
  makeTableSortable(table, "ssltokens-tokens");
  return table;
}

// Appends counts and the aggregate size of some of a row's tokens.
function addSSLTokensTokenStats(parent, entries) {
  let expired = entries.filter(isSSLTokensEntryExpired).length;
  let restored = entries.filter(entry => entry.restored).length;
  let { totalToken, totalCompressed, totalDecompressed, saved } =
    sumSSLTokensLengths(entries);

  let addStat = (l10nId, args) =>
    parent.appendChild(
      createLocalizedElement("span", "ssltokens-token-stat", l10nId, args)
    );
  if (expired < entries.length) {
    addStat("about-networking-ssl-tokens-unexpired-count", {
      count: entries.length - expired,
    });
  }
  let addIconStat = (addIcon, count) => {
    let stat = document.createElement("span");
    stat.className = "ssltokens-token-stat";
    addIcon(stat);
    stat.append(count.toLocaleString());
    parent.appendChild(stat);
  };
  if (expired) {
    addIconStat(addSSLTokensExpiredIcon, expired);
  }
  if (restored) {
    addIconStat(addSSLTokensRestoredIcon, restored);
  }
  let protocols = buildSSLTokensProtocolBadges(entries);
  if (protocols) {
    protocols.classList.add("ssltokens-token-stat");
    parent.appendChild(protocols);
  }
  if (saved !== null) {
    addStat("about-networking-ssl-tokens-tokens-size", {
      tokenLength: totalToken,
      decompressedLength: totalDecompressed,
      compressedLength: totalCompressed,
      saved,
    });
  }
}

// Collapsed by default; the summary describes the tokens it lists.
function buildSSLTokensTokensCell(group, groupKey, openKeys) {
  let td = document.createElement("td");
  let details = createSSLTokensDetails(groupKey, openKeys);
  if (document.getElementById("ssltokens_expand_tokens").pressed) {
    details.open = true;
  }
  let summary = document.createElement("summary");
  let unexpired = group.filter(entry => !isSSLTokensEntryExpired(entry));
  if (unexpired.length && unexpired.length < group.length) {
    // One set of stats for each state of "Show expired tokens".
    let stats = (entries, flag) => {
      let span = document.createElement("span");
      span.dataset[flag] = "";
      addSSLTokensTokenStats(span, entries);
      return span;
    };
    summary.append(
      stats(unexpired, "withoutExpired"),
      stats(group, "withExpired")
    );
  } else {
    addSSLTokensTokenStats(summary, group);
  }
  details.appendChild(summary);
  details.appendChild(buildSSLTokensTokenTable(group));
  td.appendChild(details);
  return td;
}

// The server cert, then buttons with popovers for its flags and chains.
function buildSSLTokensCertificateCell(entry, certsByHash) {
  let td = document.createElement("td");
  // The server cert is the first handshake cert.
  let hash = entry.handshakeHashes?.[0];
  if (hash) {
    td.appendChild(createSSLTokensCertLink(hash, certsByHash));
    td.dataset.sortValue = sslTokensCertInfo(certsByHash.get(hash)).displayName;
  }

  let buttons = document.createElement("div");
  buttons.className = "ssltokens-cert-buttons";
  td.appendChild(buttons);
  addSSLTokensPopoverButton(buttons, "about-networking-flags", {}, ul =>
    addSSLTokensFlagItems(ul, entry)
  );
  for (let [hashes, l10nId] of [
    [entry.succeededHashes, "about-networking-ssl-tokens-cert-chain"],
    [entry.handshakeHashes, "about-networking-ssl-tokens-handshake-certs"],
  ]) {
    if (hashes?.length) {
      addSSLTokensPopoverButton(buttons, l10nId, { count: hashes.length }, ul =>
        addSSLTokensCertListItems(ul, hashes, certsByHash)
      );
    }
  }
  return td;
}

function addSSLTokensFlagItems(ul, entry) {
  for (let [labelL10nId, value] of [
    ["about-networking-ssl-tokens-ev-status", entry.evStatus],
    [
      "about-networking-ssl-tokens-ct-status",
      entry.certificateTransparencyStatus,
    ],
    [
      "about-networking-ssl-tokens-overridable-error",
      entry.overridableErrorCategory,
    ],
    [
      "about-networking-ssl-tokens-built-in-root",
      entry.builtInRoot < 0 ? "unknown" : !!entry.builtInRoot,
    ],
  ]) {
    addSSLTokensFlagItem(ul, labelL10nId, value);
  }
}

function bytesToKB(bytes) {
  return Math.round(bytes / 1024);
}

function buildSSLTokensSummary(data) {
  let container = document.createElement("div");
  container.id = "ssltokens_summary";
  container.className = "ssltokens-summary";

  let { totalCompressed, totalDecompressed, saved } = sumSSLTokensLengths(
    data.entries
  );
  let usage = sslTokensCapacityUsage(data);

  let dl = document.createElement("dl");
  dl.className = "ssltokens-summary-list";
  container.appendChild(dl);

  // The capacity bar's legend breaks the tokens down by kind.
  addSSLTokensSummaryItem(
    dl,
    "about-networking-ssl-tokens-summary-tokens-term",
    [data.entries.length.toLocaleString()]
  );

  if (saved !== null) {
    addSSLTokensSummaryItem(
      dl,
      "about-networking-ssl-tokens-summary-compression-term",
      [
        [
          "about-networking-ssl-tokens-summary-compression-sizes",
          {
            decompressedLength: totalDecompressed,
            compressedLength: totalCompressed,
          },
        ],
        ["about-networking-ssl-tokens-summary-compression-saved", { saved }],
      ]
    );
  }

  if (usage.certs.count) {
    let references = data.entries.reduce(
      (sum, entry) => sum + sslTokensEntryCertHashes(entry).length,
      0
    );
    addSSLTokensSummaryItem(
      dl,
      "about-networking-ssl-tokens-summary-certs-term",
      [
        ["about-networking-ssl-tokens-summary-certs-stored", usage.certs],
        [
          "about-networking-ssl-tokens-summary-certs-references",
          { references },
        ],
      ]
    );
  }

  // network.ssl_tokens_cache_capacity is in kilobytes.
  let capacityBytes =
    Services.prefs.getIntPref("network.ssl_tokens_cache_capacity") * 1024;
  let percent = capacityBytes
    ? Math.round((100 * data.cacheSize) / capacityBytes)
    : 0;

  addSSLTokensSummaryItem(
    dl,
    "about-networking-ssl-tokens-summary-capacity-term",
    [
      [
        "about-networking-ssl-tokens-summary-capacity-used",
        {
          used: bytesToKB(data.cacheSize),
          capacity: bytesToKB(capacityBytes),
        },
      ],
      ["about-networking-ssl-tokens-summary-capacity-percent", { percent }],
    ]
  );

  container.appendChild(
    buildSSLTokensCapacityBar(usage, data.cacheSize, capacityBytes)
  );

  return container;
}

// Adds a <dt> and one <dd> per description to a <dl>. A description is an
// [l10nId, args] pair or a plain string.
function addSSLTokensSummaryItem(dl, termL10nId, descriptions) {
  let item = document.createElement("div");
  item.className = "ssltokens-summary-item";
  item.appendChild(
    createLocalizedElement("dt", "ssltokens-summary-term", termL10nId)
  );
  for (let description of descriptions) {
    if (typeof description == "string") {
      let dd = document.createElement("dd");
      dd.className = "ssltokens-summary-description";
      dd.textContent = description;
      item.appendChild(dd);
      continue;
    }
    let [l10nId, args] = description;
    item.appendChild(
      createLocalizedElement(
        "dd",
        "ssltokens-summary-description",
        l10nId,
        args
      )
    );
  }
  dl.appendChild(item);
}

// Returns { bytes, count } by kind: certs, expired and the token kinds in use.
// Tokens are counted without their certs, which are stored once for all tokens.
function sslTokensCapacityUsage(data) {
  let usage = {
    certs: { bytes: 0, count: 0 },
    expired: { bytes: 0, count: 0 },
  };
  let add = (kind, bytes, count) => {
    usage[kind] ??= { bytes: 0, count: 0 };
    usage[kind].bytes += bytes;
    usage[kind].count += count;
  };
  for (let entry of data.entries) {
    add(
      isSSLTokensEntryExpired(entry)
        ? "expired"
        : sslTokensProtocolKind(entry.alpn),
      entry.size,
      1
    );
  }
  for (let cert of data.certs) {
    add("certs", cert.size, 1);
  }
  return usage;
}

function buildSSLTokensCapacityBar(usage, usedBytes, capacityBytes) {
  let fragment = document.createDocumentFragment();
  let legend = document.createElement("span");
  legend.className = "ssltokens-capacity-legend";
  fragment.appendChild(legend);

  let bar = document.createElement("div");
  bar.className = "ssltokens-capacity-bar";
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", 0);
  bar.setAttribute("aria-valuemax", capacityBytes);
  bar.setAttribute("aria-valuenow", usedBytes);

  // Token kinds are only shown when in use.
  let kinds = [
    ...[...gSSLTokensHTTPVersions.keys()].map(alpn => ({
      kind: sslTokensProtocolKind(alpn),
      legendL10nId: "about-networking-ssl-tokens-capacity-protocol",
      detailsL10nId: "about-networking-ssl-tokens-capacity-protocol-details",
      args: { protocol: sslTokensProtocolLabel(alpn) },
    })),
    {
      kind: "other",
      legendL10nId: "about-networking-ssl-tokens-capacity-other",
      detailsL10nId: "about-networking-ssl-tokens-capacity-other-details",
    },
    {
      kind: "certs",
      legendL10nId: "about-networking-ssl-tokens-capacity-certs",
      detailsL10nId: "about-networking-ssl-tokens-capacity-certs-details",
    },
    {
      kind: "expired",
      legendL10nId: "about-networking-ssl-tokens-capacity-expired",
      detailsL10nId: "about-networking-ssl-tokens-capacity-expired-details",
    },
  ].filter(({ kind }) => usage[kind]);

  for (let { kind, legendL10nId, detailsL10nId, args } of kinds) {
    let { bytes, count } = usage[kind];
    let fraction = capacityBytes ? bytes / capacityBytes : 0;

    let segment = createLocalizedElement(
      "div",
      `ssltokens-capacity-segment ssltokens-kind-${kind}`,
      detailsL10nId,
      {
        ...args,
        count,
        bytes,
        percent: Math.round(fraction * 1000) / 10,
      }
    );
    segment.style.setProperty("--ssltokens-capacity-fraction", fraction);
    bar.appendChild(segment);

    legend.appendChild(
      createLocalizedElement(
        "span",
        `ssltokens-capacity-legend-item ssltokens-kind-${kind}`,
        legendL10nId,
        { ...args, count, size: bytesToKB(bytes) }
      )
    );
  }

  fragment.appendChild(bar);
  return fragment;
}

// One row per stored cert. References counts every use of the cert by a token,
// but a row is only shown with a token that uses it: hidden without one shown
// in this window, and marked expired if all of those are expired.
function buildSSLTokensCertsBody(data, certsByHash) {
  let refs = new Map();
  for (let entry of data.entries) {
    let shown = isSSLTokensEntryShown(entry);
    let expired = isSSLTokensEntryExpired(entry);
    for (let hash of sslTokensEntryCertHashes(entry)) {
      let ref = refs.get(hash) ?? { count: 0, shown: false, unexpired: false };
      ref.count++;
      ref.shown ||= shown;
      ref.unexpired ||= shown && !expired;
      refs.set(hash, ref);
    }
  }

  let tbody = document.createElement("tbody");
  for (let cert of certsByHash.values()) {
    let { hash } = cert;
    let ref = refs.get(hash);
    if (!ref?.shown) {
      continue;
    }
    let { issuer, notAfter } = sslTokensCertInfo(cert);
    let row = tbody.insertRow();
    row.id = sslTokensCertRowId(hash);
    if (!ref.unexpired) {
      row.dataset.expired = "";
    }

    let subject = document.createElement("td");
    setSSLTokensCertLabel(subject, hash, cert);
    row.appendChild(subject);
    row.appendChild(col(issuer));
    row.appendChild(buildSSLTokensDateCell(notAfter));
    let references = col(ref.count.toLocaleString());
    references.dataset.sortValue = ref.count;
    row.appendChild(references);
    let size = createLocalizedElement(
      "td",
      "",
      "about-networking-ssl-tokens-cert-size",
      { size: cert.size }
    );
    size.dataset.sortValue = cert.size;
    row.appendChild(size);
  }
  return tbody;
}

async function displaySSLTokensCache(data) {
  // Rebuilding would remove the button an open popover is anchored to; the
  // next refresh after it closes catches up.
  if (document.getElementById("ssltokens_popover").matches(":popover-open")) {
    return;
  }
  let summary = buildSSLTokensSummary(data);
  let certsByHash = new Map(data.certs.map(cert => [cert.hash, cert]));
  let certsBody = buildSSLTokensCertsBody(data, certsByHash);

  let table = document.getElementById("ssltokens_table");
  let openKeys = new Set();
  for (let details of table.querySelectorAll("details[open]")) {
    openKeys.add(details.dataset.tokenKey);
  }

  // One row group per group of entries: their shared columns, then a
  // full-width row with their tokens.
  let groups = document.createDocumentFragment();
  for (let [groupKey, group] of Map.groupBy(data.entries, sslTokensGroupKey)) {
    // Grouped entries share everything but the token columns.
    let entry = group[0];
    let { peerId, isolationKey } = splitSSLTokensCacheKey(entry.key);
    // Match the other about:networking tabs: don't show private-browsing
    // entries as rows unless this page is itself a private window. The
    // summary above still counts them (buildSSLTokensSummary receives the
    // full, unfiltered data.entries).
    if (!isSSLTokensEntryShown(entry)) {
      continue;
    }

    let tbody = document.createElement("tbody");
    if (group.every(isSSLTokensEntryExpired)) {
      tbody.dataset.expired = "";
    }
    let row = tbody.insertRow();
    row.appendChild(buildSSLTokensHostCell(peerId));
    row.appendChild(buildSSLTokensIsolationKeyCell(isolationKey));
    row.appendChild(buildSSLTokensCertificateCell(entry, certsByHash));
    let tokens = buildSSLTokensTokensCell(group, groupKey, openKeys);
    tokens.colSpan = row.cells.length;
    tbody.insertRow().appendChild(tokens);
    groups.appendChild(tbody);
  }

  // Translate before inserting, so a refresh doesn't paint empty strings.
  await Promise.all([
    document.l10n.translateFragment(summary),
    document.l10n.translateFragment(groups),
    document.l10n.translateFragment(certsBody),
  ]);

  updateSSLTokensExpiredVisibility(groups);
  updateSSLTokensExpiredVisibility(certsBody);

  // Moved rather than rebuilt, so the checkboxes keep their state.
  summary
    .querySelector(".ssltokens-capacity-legend")
    .appendChild(document.getElementById("ssltokens_options"));
  document.getElementById("ssltokens_summary").replaceWith(summary);
  replaceSortedTableBody(table, groups);
  replaceSortedTableBody(
    document.getElementById("ssltokens_certs_table"),
    certsBody
  );
}

function replaceSortedTableBody(table, body) {
  table.replaceChildren(table.tHead, body);
  sortTable(table);
}

// Applies "Show expired tokens" to expired rows and the summaries for each of
// its states.
function updateSSLTokensExpiredVisibility(parent) {
  let shown = document.getElementById("ssltokens_show_expired").pressed;
  for (let element of parent.querySelectorAll(
    "[data-expired], [data-with-expired]"
  )) {
    element.hidden = !shown;
  }
  for (let element of parent.querySelectorAll("[data-without-expired]")) {
    element.hidden = shown;
  }
}

function displayNetworkID() {
  try {
    let linkIsUp = gNetLinkSvc.isLinkUp;
    let linkStatusKnown = gNetLinkSvc.linkStatusKnown;
    let networkID = gNetLinkSvc.networkID;

    document.getElementById("networkid_isUp").innerText = linkIsUp;
    document.getElementById("networkid_statusKnown").innerText =
      linkStatusKnown;
    document.getElementById("networkid_id").innerText = networkID;
  } catch (e) {
    document.getElementById("networkid_isUp").innerText = "<unknown>";
    document.getElementById("networkid_statusKnown").innerText = "<unknown>";
    document.getElementById("networkid_id").innerText = "<unknown>";
  }
}

function requestAllNetworkingData() {
  for (let id in gRequestNetworkingData) {
    requestNetworkingDataForTab(id);
  }
}

function requestNetworkingDataForTab(id) {
  gRequestNetworkingData[id](gDashboardCallbacks[id]);
}

let gInited = false;
function init() {
  if (gInited) {
    return;
  }
  gInited = true;

  requestAllNetworkingData();

  let autoRefresh = document.getElementById("autorefcheck");
  if (autoRefresh.checked) {
    setAutoRefreshInterval(autoRefresh);
  }

  autoRefresh.addEventListener("click", function () {
    let refrButton = document.getElementById("refreshButton");
    if (this.checked) {
      setAutoRefreshInterval(this);
      refrButton.disabled = "disabled";
    } else {
      clearInterval(this.interval);
      refrButton.disabled = null;
    }
  });

  let refr = document.getElementById("refreshButton");
  refr.addEventListener("click", requestAllNetworkingData);
  if (document.getElementById("autorefcheck").checked) {
    refr.disabled = "disabled";
  }

  // Event delegation on #categories element
  let menu = document.getElementById("categories");
  menu.addEventListener("click", function click(e) {
    if (e.target && e.target.parentNode == menu) {
      show(e.target);
    }
  });

  let clearHTTPCache = document.getElementById("clearHTTPCache");
  clearHTTPCache.addEventListener("click", async function () {
    Services.cache2.clear();
  });

  let sslTokensTable = document.getElementById("ssltokens_table");
  document
    .getElementById("ssltokens_show_expired")
    .addEventListener("toggle", () =>
      updateSSLTokensExpiredVisibility(document.getElementById("ssltokens"))
    );

  let expandTokens = document.getElementById("ssltokens_expand_tokens");
  expandTokens.addEventListener("toggle", () => {
    for (let details of sslTokensTable.querySelectorAll("details")) {
      details.open = expandTokens.pressed;
    }
  });

  makeTableSortable(sslTokensTable, "ssltokens", true);
  makeTableSortable(
    document.getElementById("ssltokens_certs_table"),
    "ssltokens-certs"
  );
  document.addEventListener("click", sortTableOnHeaderClick);
  document.addEventListener("click", lookUpLinkedHost);
  document.addEventListener("click", showLinkedSSLTokensCert);

  let dnsLookupButton = document.getElementById("dnsLookupButton");
  dnsLookupButton.addEventListener("click", function () {
    doLookup();
  });

  let hostInput = document.getElementById("host");
  hostInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      doLookup();
    }
  });

  let clearDNSCache = document.getElementById("clearDNSCache");
  clearDNSCache.addEventListener("click", function () {
    Services.dns.clearCache(true);
  });

  if (location.hash) {
    let sectionButton = document.getElementById(
      "category-" + location.hash.substring(1)
    );
    if (sectionButton) {
      sectionButton.click();
    }
  }
}

function show(button) {
  let current_tab = document.querySelector(".active");
  let category = button.getAttribute("id").substring("category-".length);
  let content = document.getElementById(category);
  if (current_tab == content) {
    return;
  }
  current_tab.classList.remove("active");
  current_tab.hidden = true;
  content.classList.add("active");
  content.hidden = false;

  let current_button = document.querySelector("[selected=true]");
  current_button.removeAttribute("selected");
  button.setAttribute("selected", "true");

  let autoRefresh = document.getElementById("autorefcheck");
  if (autoRefresh.checked) {
    clearInterval(autoRefresh.interval);
    setAutoRefreshInterval(autoRefresh);
  }

  let title = document.getElementById("sectionTitle");
  title.textContent = button.children[0].textContent;
  location.hash = category;
}

function setAutoRefreshInterval(checkBox) {
  let active_tab = document.querySelector(".active");
  checkBox.interval = setInterval(function () {
    requestNetworkingDataForTab(active_tab.id);
  }, REFRESH_INTERVAL_MS);
}

// We use the pageshow event instead of onload. This is needed because sometimes
// the page is loaded via session-restore/bfcache. In such cases we need to call
// init() to keep the page behaviour consistent with the ticked checkboxes.
// Mostly the issue is with the autorefresh checkbox.
window.addEventListener("pageshow", function () {
  init();
});

function doLookup() {
  let host = document.getElementById("host").value;
  if (host) {
    try {
      gDashboard.requestDNSLookup(host, displayDNSLookup);
    } catch (e) {}
    try {
      gDashboard.requestDNSHTTPSRRLookup(host, displayHTTPSRRLookup);
    } catch (e) {}
  }
}

function displayDNSLookup(data) {
  let cont = document.getElementById("dnslookuptool_content");
  let parent = cont.parentNode;
  let new_cont = document.createElement("tbody");
  new_cont.setAttribute("id", "dnslookuptool_content");

  if (data.answer) {
    for (let address of data.address) {
      let row = document.createElement("tr");
      row.appendChild(col(address));
      new_cont.appendChild(row);
    }
  } else {
    new_cont.appendChild(col(data.error));
  }

  parent.replaceChild(new_cont, cont);
}

function displayHTTPSRRLookup(data) {
  let cont = document.getElementById("https_rr_content");
  let parent = cont.parentNode;
  let new_cont = document.createElement("tbody");
  new_cont.setAttribute("id", "https_rr_content");

  if (data.answer) {
    for (let record of data.records) {
      let row = document.createElement("tr");
      let alpn = record.alpn ? `alpn="${record.alpn.alpn}" ` : "";
      let noDefaultAlpn = record.noDefaultAlpn ? "noDefaultAlpn " : "";
      let port = record.port ? `port="${record.port.port}" ` : "";
      let echConfig = record.echConfig
        ? `echConfig="${record.echConfig.echConfig}" `
        : "";
      let ODoHConfig = record.ODoHConfig
        ? `odoh="${record.ODoHConfig.ODoHConfig}" `
        : "";
      let ipv4hint = "";
      let ipv6hint = "";
      if (record.ipv4Hint) {
        let ipv4Str = "";
        for (let addr of record.ipv4Hint.address) {
          ipv4Str += `${addr}, `;
        }
        // Remove ", " at the end.
        ipv4Str = ipv4Str.slice(0, -2);
        ipv4hint = `ipv4hint="${ipv4Str}" `;
      }
      if (record.ipv6Hint) {
        let ipv6Str = "";
        for (let addr of record.ipv6Hint.address) {
          ipv6Str += `${addr}, `;
        }
        // Remove ", " at the end.
        ipv6Str = ipv6Str.slice(0, -2);
        ipv6hint = `ipv6hint="${ipv6Str}" `;
      }

      let str = `${record.priority} ${record.targetName} `;
      str += `(${alpn}${noDefaultAlpn}${port}`;
      str += `${ipv4hint}${echConfig}${ipv6hint}`;
      str += `${ODoHConfig})`;
      row.appendChild(col(str));
      new_cont.appendChild(row);
    }
  } else {
    new_cont.appendChild(col(data.error));
  }

  parent.replaceChild(new_cont, cont);
}
