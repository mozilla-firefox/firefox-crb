# Address Bar Review Guidance

Each page lists what the address bar team checks in one area when reviewing
`browser/components/urlbar` changes. The items are guidance for reviewers, not
landing requirements.

The same code runs several search access points (SAPs), including the address
bar, the toolbar search bar and the New Tab search bar. The New Tab search bar
runs in a content process, so its input and view reach the parent over a
JSWindowActor (the message path, see
`browser/components/urlbar/docs/message-path.md`). The address bar and the
toolbar search bar call the parent directly unless
`browser.urlbar.ipc.chromeMessagePassing` is set. A change that works on the
direct path can fail silently on the message path, so a finding says which SAP
and which path it breaks on, or that it breaks on all of them alike (e.g. a
parent-side change). Providers, the muxer and the `UrlbarPrefs` result groups
also serve the `smartbar` SAP.

Read the doc section or JSDoc an item cites before you report it. Where a doc
and the code disagree, the code decides. A finding names what was checked that
could have disproved it (e.g. a `toWire()` that already includes the field, an
existing `receiveMessage` case, a test already in `tests/browser-newtab/`) and
what that showed. A claim only a run would settle is reported as unverified,
not as a finding. A correctness bug found while tracing is reported even when
no item covers it.

Out of scope for these pages:

- `browser/components/search/content/searchbar.js` is the legacy toolbar search
  bar, superseded by the urlbar-based `<moz-searchbar>`. Don't ask for parity
  with it or cite it as a pattern.
- `browser/components/urlbar/content/SmartbarInput.mjs` forks `UrlbarInputBase`
  until the two are merged again. Review its own changes, but don't ask for
  checks that keep the two in sync.
