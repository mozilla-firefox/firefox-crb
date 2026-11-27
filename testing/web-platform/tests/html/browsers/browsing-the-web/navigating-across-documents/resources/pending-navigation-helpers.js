// Helpers for tests that hold a navigation (and the requests of the document
// it replaces) open on the server, using
// resources/inflight-script-during-pending-navigation.py.
//
// Requires /common/utils.js for token().

const SCRIPT_BODY = "window.scriptExecuted = true;";

function resourceURL(action, id = "", kind = "") {
  const url = new URL(
    "/html/browsers/browsing-the-web/navigating-across-documents/resources/" +
      "inflight-script-during-pending-navigation.py",
    location.href);
  url.search = new URLSearchParams({ action, id, kind });
  return url.href;
}

async function command(action, id) {
  const response = await fetch(resourceURL(action, id));
  assert_true(response.ok, `Server command ${action} succeeds`);
}

// A response the server holds until release() is called. kind "script"
// answers with SCRIPT_BODY; kind "navigation" answers with a page that posts
// "navigated" to its opener; kinds "no-content" and "attachment" answer with
// an HTTP 204 and a Content-Disposition: attachment download, navigations to
// which never commit.
function heldRequest(t, kind) {
  const id = token();
  let released = false;
  const release = async () => {
    if (!released) {
      released = true;
      await command("release", id);
    }
  };
  t.add_cleanup(release);
  return {
    url: resourceURL("hold", id, kind),
    waitForRequest: () => command("wait", id),
    release,
  };
}

function popupMessage(t, win, messages, origin = location.origin) {
  return new Promise(resolve => {
    const listener = event => {
      if (event.source === win && event.origin === origin &&
          messages.includes(event.data)) {
        window.removeEventListener("message", listener);
        resolve(event.data);
      }
    };
    window.addEventListener("message", listener);
    t.add_cleanup(() => window.removeEventListener("message", listener));
  });
}

// Opens the observer page in a popup. With |parserRequest|, the popup's parser
// blocks on that held script after posting "ready".
async function openObserver(t, parserRequest = null) {
  const url = new URL(resourceURL("observer"));
  if (parserRequest) {
    url.searchParams.set("parser", parserRequest.url);
  }
  const win = window.open(url);
  assert_not_equals(win, null, "The popup opens");
  t.add_cleanup(() => win.close());
  await popupMessage(t, win, ["ready"]);
  if (parserRequest) {
    await parserRequest.waitForRequest();
    assert_equals(win.document.readyState, "loading", "The parser is blocked");
  }
  return win;
}

function loadScript(win, url) {
  win.scriptExecuted = false;
  return new Promise(resolve => {
    const script = win.document.createElement("script");
    script.onload = () => resolve("load");
    script.onerror = () => resolve("error");
    script.src = url;
    win.document.head.appendChild(script);
  });
}

function timeout(t, ms, value) {
  return new Promise(resolve => t.step_timeout(() => resolve(value), ms));
}
