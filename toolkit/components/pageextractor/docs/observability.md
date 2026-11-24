(pageextractor-observability)=

# Page Extractor observability

One extraction can cross the parent and content processes, run in several
stages, and depend on a site that behaves differently in a hidden browser. Page
Extractor records each instrumented stage as a Glean event and, while the
profiler runs, as a profiler marker, so you can investigate failures and
performance as one flow.

Each record includes the stage, process, outcome, strategy, and size
information. Nested stages
overlap, so do not add their durations together. A shared flow identifier
connects work across processes and between profiler and telemetry data.

## Investigate an extraction

1. Start the profiler from the toolbar button or `about:profiling`.
2. Run the extraction.
3. Look for `PageExtractor #n` tracks in the marker chart.

Markers are blue for success, red for unexpected errors, and yellow for outcomes
the caller handles, such as unavailable or empty content, or a page the site
blocked. Each marker's label says what happened in plain words, and its details
name the stage and strategy that produced the outcome. In a hidden browser, pass
the callback's `traceId` into `getText` so loading and extraction stay in the
same flow.

[Instrumenting JavaScript](/tools/profiler/instrumenting-javascript.md) explains
the profiler mechanism.

## Telemetry

Finished stages record `page_extractor.phase` events in the `page-extractor`
ping, subject to Glean collection settings. The event holds operational
information such as outcome, duration, strategy, and coarse size counts. It
holds no page text, URLs, image data, or error messages. The ping has no client
identifier and uses OHTTP.

When you analyze the events, pick the stage that represents the behavior you
are measuring. Counting every nested stage counts one failure more than once.
Group records by flow identifier to follow a request across processes.

The events module and the Glean metrics and pings definitions next to it define
the phases and fields. The design history is in
[bug 2065318](https://bugzilla.mozilla.org/show_bug.cgi?id=2065318) and
[bug 2058247](https://bugzilla.mozilla.org/show_bug.cgi?id=2058247).

## Bot checks

A headless load uses CaptchaDetection to notice a captcha in the page it
loaded. A puzzle, a refusal, or a failed check rejects the load at once with a
`BlockedError`. A widget that only loaded rejects the read when the
page has little text besides it. The error carries `blockReason` (`captcha`
or `off-site`), and for a captcha also `captchaType` and `captchaEvent`, so a
caller can explain the block without parsing the message.

To count blocks, use the `headless-extractor` phase, which is recorded once per
load:

- `status` is `blocked` for a blocked load.
- `block_reason` says why: `captcha` or `off-site`.
- `captcha_type` names the provider and `captcha_event` its latest state. Both
  are also set on a load that was read despite a captcha, such as a passed check
  or a widget beside readable content.

The `captcha-detected` phase records how long into the load a captcha was
found, and `detected_by` how: by its frame reporting in, by its frame's URL
when the page was read, or by a Cloudflare challenge response.

The profiler markers carry the same fields, and a blocked load's markers are
yellow and read, for example, "blocked by Cloudflare Turnstile (check failed)".
Captchas in hidden browsers are left out of the `captcha-detection` ping.

The `browser.ml.pageExtractor.captchaDetection.enabled` pref turns this
behavior off.
