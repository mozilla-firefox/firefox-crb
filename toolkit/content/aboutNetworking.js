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
const gSSLTokensHasher = Cc["@mozilla.org/security/hash;1"].createInstance(
  Ci.nsICryptoHash
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

// Turns the header cells of a table into buttons that sort its row groups or,
// with a single <tbody>, its rows. A row group sorts by its first row, and a
// cell by its data-sort-value or else its text.
function makeTableSortable(table, kind) {
  table.dataset.sortKind = kind;
  for (let th of table.tHead.rows[0].cells) {
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
  for (let th of table.tHead.rows[0].cells) {
    th.setAttribute("aria-sort", th.cellIndex == order.column ? sort : "none");
  }
  if (!table.tBodies.length) {
    return;
  }
  let groups = table.tBodies.length > 1;
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

// Cheap non-cryptographic fingerprint, used so grouping/caching doesn't need
// to stringify entire (potentially multi-KB) DER byte arrays.
function sslTokensBytesFingerprint(bytes) {
  if (!bytes || !bytes.length) {
    return "";
  }
  gSSLTokensHasher.init(Ci.nsICryptoHash.SHA256);
  gSSLTokensHasher.update(bytes, bytes.length);
  return gSSLTokensHasher.finish(/* aASCII */ true);
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
    sslTokensBytesFingerprint(entry.serverCertDER),
    entry.succeededCertChainDER?.map(sslTokensBytesFingerprint),
    entry.handshakeCertDER?.map(sslTokensBytesFingerprint),
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
// group's tokens or across the whole cache.
function sumSSLTokensLengths(entries) {
  let totalToken = 0;
  let totalCompressed = 0;
  let totalDecompressed = 0;
  for (let entry of entries) {
    totalToken += entry.tokenLength;
    totalCompressed += entry.compressedLength;
    totalDecompressed += entry.decompressedLength;
  }
  return { totalToken, totalCompressed, totalDecompressed };
}

// Every cert DER stored in an entry, including duplicates across its chains.
function sslTokensEntryCerts(entry) {
  return [
    entry.serverCertDER,
    ...(entry.succeededCertChainDER ?? []),
    ...(entry.handshakeCertDER ?? []),
  ].filter(der => der?.length);
}

function sumSSLTokensCertBytes(certs) {
  return certs.reduce((sum, der) => sum + der.length, 0);
}

function countSSLTokensCerts(entries) {
  let distinctCerts = new Map();
  let references = 0;
  let totalBytes = 0;

  for (let entry of entries) {
    let certs = sslTokensEntryCerts(entry);
    references += certs.length;
    totalBytes += sumSSLTokensCertBytes(certs);
    for (let der of certs) {
      distinctCerts.set(sslTokensBytesFingerprint(der), der.length);
    }
  }

  let distinctBytes = 0;
  for (let bytes of distinctCerts.values()) {
    distinctBytes += bytes;
  }

  return {
    distinct: distinctCerts.size,
    references,
    distinctBytes,
    totalBytes,
  };
}

// expirationTime is a PRTime (microseconds since the Unix epoch).
function sslTokensExpiryDate(expirationTime) {
  return new Date(expirationTime / 1000);
}

function isDateExpired(date) {
  return date.getTime() <= Date.now();
}

function isSSLTokensEntryExpired(entry) {
  return isDateExpired(sslTokensExpiryDate(entry.expirationTime));
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
  td.setAttribute("data-l10n-attrs", "title");
  document.l10n.setAttributes(
    td,
    "about-networking-ssl-tokens-compression-details",
    { tokenLength, decompressedLength, compressedLength }
  );
  return td;
}

function groupSSLTokensCacheEntries(entries) {
  let groups = new Map();
  for (let entry of entries) {
    let groupKey = sslTokensGroupKey(entry);
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey).push(entry);
  }
  return [...groups.entries()];
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
// by key (cache key + which collapsible) instead.
function restoreSSLTokensDetailsState(details, key, kind, openKeys) {
  details.dataset.tokenKey = key;
  details.dataset.kind = kind;
  if (openKeys.has(`${key}|${kind}`)) {
    details.open = true;
  }
}

// certDB.constructX509 takes ownership of neither its input nor output;
// failures (e.g. malformed DER) are reported as an empty subject/commonName.
// Keyed by a fingerprint of the DER bytes rather than the cache key, since
// the same cert is commonly reused across many entries/refreshes.
const gSSLTokensCertInfoCache = new Map();

// Full DN strings (e.g. "CN=example.com,O=Example Inc,C=US") are noisy, so
// callers show commonName and leave subject for a tooltip.
function sslTokensCertInfo(certDER) {
  let fingerprint = sslTokensBytesFingerprint(certDER);
  if (gSSLTokensCertInfoCache.has(fingerprint)) {
    return gSSLTokensCertInfoCache.get(fingerprint);
  }
  let info;
  try {
    let cert = gCertDB.constructX509(certDER);
    info = { subject: cert.subjectName, commonName: cert.commonName };
  } catch (e) {
    info = { subject: "", commonName: "" };
  }
  gSSLTokensCertInfoCache.set(fingerprint, info);
  return info;
}

// Parsing every cert in a chain is only useful once the user actually looks
// at it, so defer it until the collapsible is expanded (or immediately, if
// it's being restored already-open across a refresh).
function addSSLTokensCertList(
  parent,
  chainDER,
  labelL10nId,
  key,
  kind,
  openKeys
) {
  if (!chainDER || !chainDER.length) {
    return;
  }
  let details = document.createElement("details");
  restoreSSLTokensDetailsState(details, key, kind, openKeys);
  let summary = document.createElement("summary");
  document.l10n.setAttributes(summary, labelL10nId, { count: chainDER.length });
  details.appendChild(summary);
  let ul = document.createElement("ul");
  details.appendChild(ul);

  let populated = false;
  let populate = () => {
    if (populated) {
      return;
    }
    populated = true;
    for (let certDER of chainDER) {
      let li = document.createElement("li");
      let { subject, commonName } = sslTokensCertInfo(certDER);
      li.textContent = commonName || subject;
      li.title = subject;
      ul.appendChild(li);
    }
  };
  if (details.open) {
    populate();
  } else {
    details.addEventListener("toggle", () => {
      if (details.open) {
        populate();
      }
    });
  }

  parent.appendChild(details);
}

function addSSLTokensIcon(td, iconSrc, labelL10nId) {
  let icon = document.createElement("img");
  icon.className = "ssltokens-icon";
  icon.src = iconSrc;
  icon.setAttribute("data-l10n-attrs", "alt, title");
  document.l10n.setAttributes(icon, labelL10nId);
  td.appendChild(icon);
  return icon;
}

function addSSLTokensRestoredIcon(td, entry) {
  if (!entry.restored) {
    return;
  }
  addSSLTokensIcon(
    td,
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
function buildSSLTokensIsolationKeyCell(isolationKey) {
  let td = document.createElement("td");
  td.className = "ssltokens-key";
  td.title = isolationKey;
  if (!isolationKey) {
    return td;
  }
  let params = new URLSearchParams(isolationKey.slice(1));
  for (let [key, value] of params) {
    if (td.firstChild) {
      td.append(" ");
    }
    if (key != "partitionKey") {
      td.append(`${key}=${value}`);
      continue;
    }
    // A partition key is "(scheme,host[,port][,...])".
    let match = value.match(/^\((https?),([^,)]+)(.*)$/);
    if (match) {
      let [, scheme, hostname, rest] = match;
      td.append(`(${scheme},`, createDNSLookupLink(hostname), rest);
    } else {
      td.append(value);
    }
  }
  return td;
}

// ISO 8601 in UTC, without milliseconds, so it also sorts as text.
function buildSSLTokensExpiresCell(expires) {
  let td = document.createElement("td");
  td.textContent = expires.toISOString().replace(/\.\d+Z$/, "Z");
  return td;
}

// Short labels of the HTTP versions' ALPN protocol IDs. Each label is also the
// kind that colors its tokens; tokens with any other ALPN, or none, are of kind
// "other".
const gSSLTokensHTTPVersions = new Map([
  ["h3", "h3"],
  ["h2", "h2"],
  ["http/1.1", "h1"],
]);

function sslTokensProtocolLabel(alpn) {
  return gSSLTokensHTTPVersions.get(alpn) ?? alpn;
}

function sslTokensProtocolKind(alpn) {
  return gSSLTokensHTTPVersions.get(alpn) ?? "other";
}

function createSSLTokensProtocolBadge(alpn) {
  let badge = document.createElement("span");
  badge.className = `ssltokens-protocol-badge ssltokens-kind-${sslTokensProtocolKind(alpn)}`;
  badge.textContent = sslTokensProtocolLabel(alpn);
  return badge;
}

// Badges for the ALPNs of some tokens, in label order, each followed by its
// number of tokens if withCounts; null if no token records an ALPN.
function buildSSLTokensProtocolBadges(tagName, entries, withCounts) {
  let byALPN = Map.groupBy(
    entries.filter(entry => entry.alpn),
    entry => entry.alpn
  );
  if (!byALPN.size) {
    return null;
  }
  let container = document.createElement(tagName);
  container.className = "ssltokens-protocol-badges";
  let alpns = [...byALPN.keys()].sort((a, b) =>
    gTableSortCollator.compare(
      sslTokensProtocolLabel(a),
      sslTokensProtocolLabel(b)
    )
  );
  for (let alpn of alpns) {
    container.appendChild(createSSLTokensProtocolBadge(alpn));
    if (withCounts) {
      container.appendChild(
        createLocalizedElement(
          "span",
          "ssltokens-protocol-count",
          "about-networking-ssl-tokens-summary-protocol-count",
          { count: byALPN.get(alpn).length }
        )
      );
    }
  }
  return container;
}

function buildSSLTokensTokenRow(entry) {
  let row = document.createElement("tr");
  let expires = sslTokensExpiryDate(entry.expirationTime);

  let token = document.createElement("td");
  token.dataset.sortValue = entry.tokenId;
  addSSLTokensRestoredIcon(token, entry);
  if (isDateExpired(expires)) {
    addSSLTokensExpiredIcon(token);
    row.dataset.expired = "";
  }
  token.append(`#${entry.tokenId}`);
  row.appendChild(token);

  let protocol = document.createElement("td");
  if (entry.alpn) {
    protocol.appendChild(createSSLTokensProtocolBadge(entry.alpn));
  }
  row.appendChild(protocol);

  row.appendChild(buildSSLTokensExpiresCell(expires));
  row.appendChild(buildSSLTokensCompressionCell(entry));
  return row;
}

function buildSSLTokensTokenTable(group) {
  let table = document.createElement("table");
  table.className = "ssltokens-token-table";
  let header = table.createTHead().insertRow();
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
  let { totalToken, totalCompressed, totalDecompressed } =
    sumSSLTokensLengths(entries);
  let saved = sslTokensCompressionSavedPercent(
    totalCompressed,
    totalDecompressed
  );

  let addStat = (l10nId, args) => {
    let stat = createLocalizedElement(
      "span",
      "ssltokens-token-stat",
      l10nId,
      args
    );
    stat.setAttribute("data-l10n-attrs", "title");
    parent.appendChild(stat);
  };
  if (expired < entries.length) {
    addStat("about-networking-ssl-tokens-unexpired-count", {
      count: entries.length - expired,
    });
  }
  if (expired) {
    addStat("about-networking-ssl-tokens-expired-count", { count: expired });
  }
  if (restored) {
    addStat("about-networking-ssl-tokens-restored-count", { count: restored });
  }
  let protocols = buildSSLTokensProtocolBadges("span", entries, false);
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
function buildSSLTokensTokensCell(group, key, openKeys) {
  let td = document.createElement("td");
  let details = document.createElement("details");
  restoreSSLTokensDetailsState(details, key, "tokens", openKeys);
  if (document.getElementById("ssltokens_expand_tokens").checked) {
    details.open = true;
  }
  let summary = document.createElement("summary");
  let unexpired = group.filter(entry => !isSSLTokensEntryExpired(entry));
  if (unexpired.length && unexpired.length < group.length) {
    // One set of stats for each state of "Show expired tokens".
    let withoutExpired = document.createElement("span");
    withoutExpired.dataset.withoutExpired = "";
    addSSLTokensTokenStats(withoutExpired, unexpired);
    let withExpired = document.createElement("span");
    withExpired.dataset.withExpired = "";
    addSSLTokensTokenStats(withExpired, group);
    summary.append(withoutExpired, withExpired);
  } else {
    addSSLTokensTokenStats(summary, group);
  }
  details.appendChild(summary);
  details.appendChild(buildSSLTokensTokenTable(group));
  td.appendChild(details);
  return td;
}

function buildSSLTokensCertificateCell(entry, groupKey, openKeys) {
  let td = document.createElement("td");

  if (entry.serverCertDER && entry.serverCertDER.length) {
    let { subject: fullSubject, commonName } = sslTokensCertInfo(
      entry.serverCertDER
    );
    let name = commonName || fullSubject;
    let subject = document.createElement("div");
    // Wildcard and non-host names can't be looked up.
    if (/^[a-z0-9.-]+$/i.test(commonName)) {
      subject.appendChild(createDNSLookupLink(commonName));
    } else {
      subject.textContent = name;
    }
    subject.title = fullSubject;
    td.appendChild(subject);
    td.dataset.sortValue = name;
  }

  let flagsDetails = document.createElement("details");
  restoreSSLTokensDetailsState(flagsDetails, groupKey, "flags", openKeys);
  let flagsSummary = document.createElement("summary");
  document.l10n.setAttributes(flagsSummary, "about-networking-flags");
  flagsDetails.appendChild(flagsSummary);
  let flagsList = document.createElement("ul");
  let flagItems = [
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
  ];
  for (let [labelL10nId, value] of flagItems) {
    addSSLTokensFlagItem(flagsList, labelL10nId, value);
  }
  flagsDetails.appendChild(flagsList);
  td.appendChild(flagsDetails);

  addSSLTokensCertList(
    td,
    entry.succeededCertChainDER,
    "about-networking-ssl-tokens-cert-chain",
    groupKey,
    "chain",
    openKeys
  );
  addSSLTokensCertList(
    td,
    entry.handshakeCertDER,
    "about-networking-ssl-tokens-handshake-certs",
    groupKey,
    "handshake",
    openKeys
  );

  return td;
}

function buildSSLTokensSummary(data) {
  let container = document.createElement("div");
  container.id = "ssltokens_summary";
  container.className = "ssltokens-summary";

  let { totalCompressed, totalDecompressed } = sumSSLTokensLengths(
    data.entries
  );

  let dl = document.createElement("dl");
  dl.className = "ssltokens-summary-list";
  container.appendChild(dl);

  let tokenDescriptions = [
    [
      "about-networking-ssl-tokens-summary-tokens-total",
      { count: data.entries.length },
    ],
  ];
  let totalExpired = data.entries.filter(isSSLTokensEntryExpired).length;
  if (totalExpired) {
    tokenDescriptions.push([
      "about-networking-ssl-tokens-summary-tokens-expired",
      { count: totalExpired },
    ]);
  }
  let tokensItem = addSSLTokensSummaryItem(
    dl,
    "about-networking-ssl-tokens-summary-tokens-term",
    tokenDescriptions
  );
  let protocols = buildSSLTokensProtocolBadges("dd", data.entries, true);
  if (protocols) {
    protocols.classList.add("ssltokens-summary-description");
    tokensItem.appendChild(protocols);
  }

  let saved = sslTokensCompressionSavedPercent(
    totalCompressed,
    totalDecompressed
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

  let certs = countSSLTokensCerts(data.entries);
  if (certs.references) {
    addSSLTokensSummaryItem(
      dl,
      "about-networking-ssl-tokens-summary-certs-term",
      [
        [
          "about-networking-ssl-tokens-summary-certs-stored",
          { references: certs.references, totalBytes: certs.totalBytes },
        ],
        [
          "about-networking-ssl-tokens-summary-certs-distinct",
          { distinct: certs.distinct, distinctBytes: certs.distinctBytes },
        ],
      ]
    );
  }

  // network.ssl_tokens_cache_capacity is in kilobytes.
  let capacityBytes =
    Services.prefs.getIntPref("network.ssl_tokens_cache_capacity") * 1024;
  let percent = capacityBytes
    ? Math.round((100 * totalCompressed) / capacityBytes)
    : 0;

  addSSLTokensSummaryItem(
    dl,
    "about-networking-ssl-tokens-summary-capacity-term",
    [
      [
        "about-networking-ssl-tokens-summary-capacity-used",
        {
          used: Math.round(totalCompressed / 1024),
          capacity: Math.round(capacityBytes / 1024),
        },
      ],
      ["about-networking-ssl-tokens-summary-capacity-percent", { percent }],
    ]
  );

  container.appendChild(
    buildSSLTokensCapacityBar(data.entries, totalCompressed, capacityBytes)
  );

  return container;
}

// Adds a <dt> and one <dd> per [l10nId, args] pair to a <dl>, and returns the
// element that groups them.
function addSSLTokensSummaryItem(dl, termL10nId, descriptions) {
  let item = document.createElement("div");
  item.className = "ssltokens-summary-item";
  item.appendChild(
    createLocalizedElement("dt", "ssltokens-summary-term", termL10nId)
  );
  for (let [l10nId, args] of descriptions) {
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
  return item;
}

// Each entry is compressed as a whole, so split an unexpired entry's
// compressedLength between its certs and the rest in proportion to their
// uncompressed sizes.
// Returns { bytes, count } by kind, for the kinds in use.
function sslTokensCapacityUsage(entries) {
  let usage = {};
  let add = (kind, bytes, count) => {
    usage[kind] ??= { bytes: 0, count: 0 };
    usage[kind].bytes += bytes;
    usage[kind].count += count;
  };
  for (let entry of entries) {
    if (isSSLTokensEntryExpired(entry)) {
      add("expired", entry.compressedLength, 1);
      continue;
    }
    let certs = sslTokensEntryCerts(entry);
    let compressedCertBytes = entry.decompressedLength
      ? (entry.compressedLength * sumSSLTokensCertBytes(certs)) /
        entry.decompressedLength
      : 0;
    add("certs", compressedCertBytes, certs.length);
    add(
      sslTokensProtocolKind(entry.alpn),
      entry.compressedLength - compressedCertBytes,
      1
    );
  }
  return usage;
}

function buildSSLTokensCapacityBar(entries, usedBytes, capacityBytes) {
  let usage = sslTokensCapacityUsage(entries);
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
    ...[...gSSLTokensHTTPVersions.values()].map(kind => [
      kind,
      "about-networking-ssl-tokens-capacity-protocol",
      "about-networking-ssl-tokens-capacity-protocol-details",
      { protocol: kind },
    ]),
    [
      "other",
      "about-networking-ssl-tokens-capacity-other",
      "about-networking-ssl-tokens-capacity-other-details",
    ],
  ].filter(([kind]) => usage[kind]);
  kinds.push(
    [
      "certs",
      "about-networking-ssl-tokens-capacity-certs",
      "about-networking-ssl-tokens-capacity-certs-details",
    ],
    [
      "expired",
      "about-networking-ssl-tokens-capacity-expired",
      "about-networking-ssl-tokens-capacity-expired-details",
    ]
  );

  for (let [kind, legendL10nId, detailsL10nId, args] of kinds) {
    let { bytes, count } = usage[kind] ?? { bytes: 0, count: 0 };
    let fraction = capacityBytes ? bytes / capacityBytes : 0;

    let segment = createLocalizedElement(
      "div",
      `ssltokens-capacity-segment ssltokens-kind-${kind}`,
      detailsL10nId,
      {
        ...args,
        count,
        bytes: Math.round(bytes),
        percent: Math.round(fraction * 1000) / 10,
      }
    );
    segment.style.setProperty("--ssltokens-capacity-fraction", fraction);
    segment.setAttribute("data-l10n-attrs", "title");
    bar.appendChild(segment);

    legend.appendChild(
      createLocalizedElement(
        "span",
        `ssltokens-capacity-legend-item ssltokens-kind-${kind}`,
        legendL10nId,
        { ...args, size: Math.round(bytes / 1024) }
      )
    );
  }

  fragment.appendChild(bar);
  return fragment;
}

async function displaySSLTokensCache(data) {
  let summary = buildSSLTokensSummary(data);

  let table = document.getElementById("ssltokens_table");
  let openKeys = new Set();
  for (let details of table.querySelectorAll("details[open]")) {
    openKeys.add(`${details.dataset.tokenKey}|${details.dataset.kind}`);
  }

  // One row group per group of entries: their shared columns, then a
  // full-width row with their tokens.
  let groups = document.createDocumentFragment();
  for (let [groupKey, group] of groupSSLTokensCacheEntries(data.entries)) {
    // Grouped entries share everything but the token columns.
    let entry = group[0];
    let { peerId, isolationKey } = splitSSLTokensCacheKey(entry.key);
    // Match the other about:networking tabs: don't show private-browsing
    // entries as rows unless this page is itself a private window. The
    // summary above still counts them (buildSSLTokensSummary receives the
    // full, unfiltered data.entries).
    if (!gIsPrivateBrowsing && isPrivateBrowsingEntry(isolationKey)) {
      continue;
    }

    let tbody = document.createElement("tbody");
    if (group.every(isSSLTokensEntryExpired)) {
      tbody.dataset.expired = "";
    }
    let row = tbody.insertRow();
    row.appendChild(buildSSLTokensHostCell(peerId));
    row.appendChild(buildSSLTokensIsolationKeyCell(isolationKey));
    row.appendChild(buildSSLTokensCertificateCell(entry, groupKey, openKeys));
    let tokens = buildSSLTokensTokensCell(group, groupKey, openKeys);
    tokens.colSpan = row.cells.length;
    tbody.insertRow().appendChild(tokens);
    groups.appendChild(tbody);
  }

  updateSSLTokensExpiredVisibility(groups);

  // Translate before inserting, so a refresh doesn't paint empty strings.
  await Promise.all([
    document.l10n.translateFragment(summary),
    document.l10n.translateFragment(groups),
  ]);

  // Moved rather than rebuilt, so the checkboxes keep their state.
  summary
    .querySelector(".ssltokens-capacity-legend")
    .appendChild(document.getElementById("ssltokens_options"));
  document.getElementById("ssltokens_summary").replaceWith(summary);
  table.replaceChildren(table.tHead, groups);
  sortTable(table);
}

// Applies "Show expired tokens" to expired rows and the summaries for each of
// its states.
function updateSSLTokensExpiredVisibility(parent) {
  let shown = document.getElementById("ssltokens_show_expired").checked;
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
    .addEventListener("change", () =>
      updateSSLTokensExpiredVisibility(sslTokensTable)
    );

  let expandTokens = document.getElementById("ssltokens_expand_tokens");
  expandTokens.addEventListener("change", () => {
    for (let details of sslTokensTable.querySelectorAll(
      'details[data-kind="tokens"]'
    )) {
      details.open = expandTokens.checked;
    }
  });

  makeTableSortable(sslTokensTable, "ssltokens");
  document.addEventListener("click", sortTableOnHeaderClick);
  document.addEventListener("click", lookUpLinkedHost);

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
