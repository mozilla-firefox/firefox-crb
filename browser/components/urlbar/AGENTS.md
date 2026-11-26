# Address bar instructions

Scoped guidance for `browser/components/urlbar/`. The `../../AGENTS.md` and the
global `../../../AGENTS.md` still apply.

## Before you change code

- Read `.agents/skills/urlbar-review/references/index.md` first. It describes
  the three search bars this code serves, the direct and message paths, and
  what is out of scope.
- Read `browser/components/urlbar/docs/process-boundary.md`,
  `browser/components/urlbar/docs/message-path.md` and the checklist
  `boundary.md` beside `index.md` before you change the input, the view, the
  actors or what a provider sends to the view. Read `results.md` there before
  you change a provider, a result, the muxer or the prefs, and
  `telemetry-and-tests.md` before you change a metric or a test.

## Tests

- Run a browser test over the message path locally with
  `--setpref=browser.urlbar.ipc.chromeMessagePassing=true`.
- The directory is a TypeScript `checkJs` project (`tsconfig.json`); check it
  with `./mach lint -l typescript browser/components/urlbar/`. Files in its
  `exclude` list aren't checked.

## Review

Load the `urlbar-review` skill (`.agents/skills/urlbar-review/SKILL.md`) to
review a change here.
