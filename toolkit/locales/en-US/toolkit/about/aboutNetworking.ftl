# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

about-networking-title = About Networking
about-networking-http = HTTP
about-networking-http-clear-cache-button = Clear HTTP Cache
about-networking-sockets = Sockets
about-networking-dns = DNS
about-networking-dns-clear-cache-button = Clear DNS Cache
about-networking-dns-trr-url = DoH URL
about-networking-dns-trr-mode = DoH Mode
about-networking-dns-suffix = DNS suffix
about-networking-websockets = WebSockets
about-networking-alt-svc = Alt-Svc
about-networking-alt-svc-origin = Origin
about-networking-alt-svc-alternate = Alternate
about-networking-alt-svc-alpn = ALPN
about-networking-alt-svc-validated = Validated
about-networking-alt-svc-ttl = TTL
about-networking-alt-svc-origin-attributes-suffix = Isolation Key
about-networking-ssl-tokens = TLS Tokens

## Summary above the TLS tokens table: each "-term" message labels the
## messages that follow it.

about-networking-ssl-tokens-summary-tokens-term = Tokens
# $count (Number) - Number of cached tokens that have already expired
about-networking-ssl-tokens-summary-tokens-expired = { $count ->
    [one] { $count } expired
   *[other] { $count } expired
}
about-networking-ssl-tokens-summary-compression-term = Compressed
# $decompressedLength (Number) - Total uncompressed size in bytes across all tokens
# $compressedLength (Number) - Total compressed size in bytes across all tokens
about-networking-ssl-tokens-summary-compression-sizes = { $decompressedLength } → { $compressedLength } B
# $saved (Number) - Percentage of space saved by compression
about-networking-ssl-tokens-summary-compression-saved = { $saved }% saved
# Certificates are stored inside every cached token, so the same certificate is
# held many times over.
about-networking-ssl-tokens-summary-certs-term = Certs
# $references (Number) - Total number of stored certificate copies
# $totalBytes (Number) - Uncompressed size of all stored copies, in bytes
about-networking-ssl-tokens-summary-certs-stored = { $references } stored ({ $totalBytes } B)
# $distinct (Number) - Number of unique certificates across all tokens
# $distinctBytes (Number) - Uncompressed size of the unique certificates, in bytes
about-networking-ssl-tokens-summary-certs-distinct = { $distinct } distinct ({ $distinctBytes } B)
about-networking-ssl-tokens-summary-capacity-term = Cache
# $used (Number) - Cache size currently in use, in kilobytes
# $capacity (Number) - Total cache capacity, in kilobytes
about-networking-ssl-tokens-summary-capacity-used = { $used } / { $capacity } KB
# $percent (Number) - Percentage of the cache capacity currently in use
about-networking-ssl-tokens-summary-capacity-percent = { $percent }% used

##

# Each cached token is compressed together with its certificates, so the cache
# space taken by unexpired tokens and by their certificates is estimated.
# $protocol (String) - Application protocol (ALPN) of the tokens' connections, such as h2 or h3
# $size (Number) - Estimated cache space taken by unexpired tokens of that protocol, excluding their certificates, in kilobytes
about-networking-ssl-tokens-capacity-protocol = { $protocol }: ~{ $size } KB
# $size (Number) - Estimated cache space taken by unexpired tokens of any other or no protocol, excluding their certificates, in kilobytes
about-networking-ssl-tokens-capacity-other = Other tokens: ~{ $size } KB
# $size (Number) - Estimated cache space taken by the certificates of unexpired tokens, in kilobytes
about-networking-ssl-tokens-capacity-certs = Certs: ~{ $size } KB
# $size (Number) - Cache space taken by expired tokens, including their certificates, in kilobytes
about-networking-ssl-tokens-capacity-expired = Expired: { $size } KB
# Tooltip on the cache capacity bar's segment for the unexpired tokens of one protocol.
# $protocol (String) - Application protocol (ALPN) of the tokens' connections, such as h2 or h3
# $count (Number) - Number of unexpired tokens of that protocol
# $bytes (Number) - Estimated compressed cache space taken by those tokens, excluding their certificates, in bytes
# $percent (Number) - Percentage of the cache capacity taken by this segment
about-networking-ssl-tokens-capacity-protocol-details =
  .title = Unexpired { $protocol } tokens: { $count }, ~{ $bytes } B compressed, excluding certs ({ $percent }% of capacity)
# Tooltip on the cache capacity bar's segment for the unexpired tokens of any other or no protocol.
# $count (Number) - Number of those unexpired tokens
# $bytes (Number) - Estimated compressed cache space taken by those tokens, excluding their certificates, in bytes
# $percent (Number) - Percentage of the cache capacity taken by this segment
about-networking-ssl-tokens-capacity-other-details =
  .title = Other unexpired tokens: { $count }, ~{ $bytes } B compressed, excluding certs ({ $percent }% of capacity)
# Tooltip on the cache capacity bar's certificates segment.
# $count (Number) - Number of certificates stored in unexpired tokens
# $bytes (Number) - Estimated compressed cache space taken by those certificates, in bytes
# $percent (Number) - Percentage of the cache capacity taken by this segment
about-networking-ssl-tokens-capacity-certs-details =
  .title = Certs in unexpired tokens: { $count }, ~{ $bytes } B compressed ({ $percent }% of capacity)
# Tooltip on the cache capacity bar's expired tokens segment.
# $count (Number) - Number of expired tokens
# $bytes (Number) - Compressed cache space taken by expired tokens, including their certificates, in bytes
# $percent (Number) - Percentage of the cache capacity taken by this segment
about-networking-ssl-tokens-capacity-expired-details =
  .title = Expired tokens: { $count }, { $bytes } B compressed, including certs ({ $percent }% of capacity)
about-networking-ssl-tokens-show-expired = Show expired tokens
about-networking-ssl-tokens-expand-tokens = Expand all tokens
about-networking-ssl-tokens-partition-key = Partition Key
about-networking-ssl-tokens-expires = Expires
about-networking-ssl-tokens-certificate = Cert
# $count (Number) - Number of unexpired tokens sharing this row's host and certificate
about-networking-ssl-tokens-unexpired-count = { $count ->
    [one] { $count } token
   *[other] { $count } tokens
}
# $count (Number) - Number of expired tokens sharing this row's host and certificate
about-networking-ssl-tokens-expired-count = { $count ->
    [one] { $count } expired
   *[other] { $count } expired
}
# $count (Number) - Number of this row's tokens that were restored from storage at startup
about-networking-ssl-tokens-restored-count = { $count ->
    [one] { $count } restored
   *[other] { $count } restored
}
# $tokenLength (Number) - Total size in bytes of this row's raw TLS resumption tokens
# $decompressedLength (Number) - Total size in bytes of this row's tokens before compression
# $compressedLength (Number) - Total size in bytes of this row's tokens after compression
# $saved (Number) - Percentage of space saved by compression
about-networking-ssl-tokens-tokens-size = { $compressedLength } B ({ $saved }% saved)
    .title = Tokens: { $tokenLength } B. Encoded: { $decompressedLength } → { $compressedLength } B.

## Headers of the per-row table listing each token.

about-networking-ssl-tokens-token-column = Token
# Header of the column with the application protocol (such as h2 or h3) of the
# connection each token is from
about-networking-ssl-tokens-protocol-column = Protocol
# Header of the column with the space saved by compressing each token
about-networking-ssl-tokens-compression-column = Compression

##

about-networking-ssl-tokens-restored =
  .alt = Restored from storage
  .title = Restored from storage
about-networking-ssl-tokens-expired =
  .alt = Expired
  .title = Expired
# $tokenLength (Number) - Total size in bytes of the raw TLS resumption token(s)
# $decompressedLength (Number) - Total size in bytes before compression
# $compressedLength (Number) - Total size in bytes after compression
about-networking-ssl-tokens-compression-details =
  .title = Tokens: { $tokenLength } B. Encoded: { $decompressedLength } → { $compressedLength } B.
about-networking-ssl-tokens-ev-status = EV cert
about-networking-ssl-tokens-ct-status = Cert Transparency status
about-networking-ssl-tokens-overridable-error = Overridable error category
about-networking-ssl-tokens-built-in-root = Built-in root
# $count (Number) - Number of certs in the succeeded cert chain
about-networking-ssl-tokens-cert-chain = Cert chain ({ $count })
# $count (Number) - Number of certs seen during the TLS handshake
about-networking-ssl-tokens-handshake-certs = Handshake certs ({ $count })
about-networking-refresh = Refresh
about-networking-auto-refresh = Autorefresh every 3 seconds
about-networking-hostname = Hostname
about-networking-port = Port
about-networking-http-version = HTTP Version
about-networking-ssl = SSL
about-networking-active = Active
about-networking-idle = Idle
about-networking-host = Host
about-networking-type = Type
about-networking-sent = Sent
about-networking-received = Received
about-networking-family = Family
about-networking-trr = TRR
about-networking-addresses = Addresses
about-networking-expires = Expires (Seconds)
about-networking-originAttributesSuffix = Isolation Key
about-networking-flags = Extra flags
about-networking-messages-sent = Messages Sent
about-networking-messages-received = Messages Received
about-networking-bytes-sent = Bytes Sent
about-networking-bytes-received = Bytes Received
about-networking-logging = Logging
about-networking-dns-lookup = DNS Lookup
about-networking-dns-lookup-button = Resolve
about-networking-dns-domain = Domain:
about-networking-dns-lookup-table-column = IPs
about-networking-dns-https-rrs-lookup-table-column = HTTPS RRs
about-networking-networkid = Network ID
about-networking-networkid-id = Network ID
# Note: do not translate about:logging, as it is a URL.
about-networking-moved-about-logging = This page has been moved to <a data-l10n-name="about-logging-url">about:logging</a>.

## Link is intended as "network link"

about-networking-networkid-is-up = Link is up
about-networking-networkid-status-known = Link status is known

##
