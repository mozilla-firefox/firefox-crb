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
about-networking-ssl-tokens-summary-compression-term = Compressed
# $decompressedLength (Number) - Total uncompressed size in bytes across all tokens
# $compressedLength (Number) - Total compressed size in bytes across all tokens
about-networking-ssl-tokens-summary-compression-sizes = { $decompressedLength } → { $compressedLength } B
# $saved (Number) - Percentage of space saved by compression
about-networking-ssl-tokens-summary-compression-saved = { $saved }% saved
about-networking-ssl-tokens-summary-certs-term = Certs
# Each certificate is stored once, however many tokens use it.
# $count (Number) - Number of stored certificates
# $bytes (Number) - Cache space taken by the stored certificates, in bytes
about-networking-ssl-tokens-summary-certs-stored = { $count } stored ({ $bytes } B)
# $references (Number) - Number of times tokens use a stored certificate
about-networking-ssl-tokens-summary-certs-references = { $references ->
    [one] { $references } reference
   *[other] { $references } references
}
about-networking-ssl-tokens-summary-capacity-term = Cache
# $used (Number) - Cache size currently in use, in kilobytes
# $capacity (Number) - Total cache capacity, in kilobytes
about-networking-ssl-tokens-summary-capacity-used = { $used } / { $capacity } KB
# $percent (Number) - Percentage of the cache capacity currently in use
about-networking-ssl-tokens-summary-capacity-percent = { $percent }% used

## Legend and tooltips of the cache capacity bar. Each certificate is stored
## once, however many tokens use it, so the tokens' cache space excludes their
## certificates. In the legend, "@" joins a number of items and the cache space
## they take.

# $protocol (String) - HTTP version of the tokens' connections: H1, H2 or H3
# $count (Number) - Number of unexpired tokens of that protocol
# $size (Number) - Cache space taken by those tokens, in kilobytes
about-networking-ssl-tokens-capacity-protocol = { $protocol }: { $count } @ { $size } KB
# $count (Number) - Number of unexpired tokens of any other or no protocol
# $size (Number) - Cache space taken by those tokens, in kilobytes
about-networking-ssl-tokens-capacity-other = Other tokens: { $count } @ { $size } KB
# $count (Number) - Number of stored certificates
# $size (Number) - Cache space taken by the stored certificates, in kilobytes
about-networking-ssl-tokens-capacity-certs = Certs: { $count } @ { $size } KB
# $count (Number) - Number of expired tokens
# $size (Number) - Cache space taken by expired tokens, in kilobytes
about-networking-ssl-tokens-capacity-expired = Expired: { $count } @ { $size } KB
# Tooltip on the cache capacity bar's segment for the unexpired tokens of one protocol.
# $protocol (String) - HTTP version of the tokens' connections: H1, H2 or H3
# $count (Number) - Number of unexpired tokens of that protocol
# $bytes (Number) - Cache space taken by those tokens, in bytes
# $percent (Number) - Percentage of the cache capacity taken by this segment
about-networking-ssl-tokens-capacity-protocol-details =
  .title = Unexpired { $protocol } tokens: { $count }, { $bytes } B ({ $percent }% of capacity)
# Tooltip on the cache capacity bar's segment for the unexpired tokens of any other or no protocol.
# $count (Number) - Number of those unexpired tokens
# $bytes (Number) - Cache space taken by those tokens, in bytes
# $percent (Number) - Percentage of the cache capacity taken by this segment
about-networking-ssl-tokens-capacity-other-details =
  .title = Other unexpired tokens: { $count }, { $bytes } B ({ $percent }% of capacity)
# Tooltip on the cache capacity bar's certificates segment.
# $count (Number) - Number of stored certificates
# $bytes (Number) - Cache space taken by those certificates, in bytes
# $percent (Number) - Percentage of the cache capacity taken by this segment
about-networking-ssl-tokens-capacity-certs-details =
  .title = Certs: { $count }, { $bytes } B ({ $percent }% of capacity)
# Tooltip on the cache capacity bar's expired tokens segment.
# $count (Number) - Number of expired tokens
# $bytes (Number) - Cache space taken by those tokens, in bytes
# $percent (Number) - Percentage of the cache capacity taken by this segment
about-networking-ssl-tokens-capacity-expired-details =
  .title = Expired tokens: { $count }, { $bytes } B ({ $percent }% of capacity)

##

about-networking-ssl-tokens-show-expired =
  .label = Show expired tokens
about-networking-ssl-tokens-expand-tokens =
  .label = Expand all tokens
about-networking-ssl-tokens-partition-key = Partition Key
about-networking-ssl-tokens-expires = Expires
about-networking-ssl-tokens-certificate = Cert
# $count (Number) - Number of unexpired tokens sharing this row's host and certificate
about-networking-ssl-tokens-unexpired-count = { $count ->
    [one] { $count } token
   *[other] { $count } tokens
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
# Shown in the Protocol column for a token whose connection negotiated no
# application protocol (ALPN)
about-networking-ssl-tokens-protocol-none = None
# Shown in the Protocol column for a token whose application protocol (ALPN)
# couldn't be read
about-networking-ssl-tokens-protocol-unknown = Unknown
# Shown in the Protocol column for a token whose stored data couldn't be decoded
about-networking-ssl-tokens-protocol-not-decoded = Not decoded

## Table of the certificates stored for the TLS tokens, each once.

about-networking-ssl-tokens-certs-heading = Certs
about-networking-ssl-tokens-cert-subject = Subject
about-networking-ssl-tokens-cert-issuer = Issuer
# Header of the column with the end of each certificate's validity period
about-networking-ssl-tokens-cert-not-after = Not After
# Header of the column with the number of times tokens use each certificate
about-networking-ssl-tokens-cert-references = References
# Header of the column with the cache space each certificate takes
about-networking-ssl-tokens-cert-size-column = Size
# $size (Number) - Cache space taken by the certificate, in bytes
about-networking-ssl-tokens-cert-size = { $size } B

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
