// Helpers for tests that hold a navigation (and the requests of the document
// it replaces) open on the server, using
// resources/inflight-script-during-pending-navigation.py.
//
// Requires /common/utils.js for token().

const SCRIPT_BODY = "window.scriptExecuted = true;";

function serverEndpoint(action, id = "", kind = "") {
  const url = new URL(
    "/html/browsers/browsing-the-web/navigating-across-documents/resources/" +
      "inflight-script-during-pending-navigation.py",
    location.href);
  url.search = new URLSearchParams({ action, id, kind });
  return url.href;
}

async function sendServerCommand(action, id) {
  const response = await fetch(serverEndpoint(action, id));
  assert_true(response.ok, `Server command ${action} succeeds`);
}

// A response of |kind| that the server holds until respond() is called. See
// inflight-script-during-pending-navigation.py for the kinds.
function createDeferredResponse(t, kind) {
  const id = token();
  let responded = false;
  const respond = async () => {
    if (!responded) {
      responded = true;
      await sendServerCommand("release", id);
    }
  };
  t.add_cleanup(respond);
  return {
    url: serverEndpoint("hold", id, kind),
    waitUntilReceived: () => sendServerCommand("wait", id),
    respond,
  };
}

function waitForMessage(t, win, message) {
  return new Promise(resolve => {
    const listener = event => {
      if (event.source === win && event.origin === location.origin &&
          event.data === message) {
        window.removeEventListener("message", listener);
        resolve(message);
      }
    };
    window.addEventListener("message", listener);
    t.add_cleanup(() => window.removeEventListener("message", listener));
  });
}

// Opens the test page in a popup. With |parserBlockingResponse|, the popup's
// parser blocks on that deferred script after posting "ready".
async function openTestPage(t, parserBlockingResponse = null) {
  const url = new URL(serverEndpoint("test-page"));
  if (parserBlockingResponse) {
    url.searchParams.set("parser-blocking-script", parserBlockingResponse.url);
  }
  const win = window.open(url);
  assert_not_equals(win, null, "The popup opens");
  t.add_cleanup(() => win.close());
  await waitForMessage(t, win, "ready");
  if (parserBlockingResponse) {
    await parserBlockingResponse.waitUntilReceived();
    assert_equals(win.document.readyState, "loading", "The parser is blocked");
  }
  return win;
}

// Appends an iframe navigated to |src| and resolves once it has loaded.
function withIframe(t, src) {
  const iframe = document.createElement("iframe");
  t.add_cleanup(() => iframe.remove());
  return new Promise(resolve => {
    iframe.addEventListener("load", () => resolve(iframe), {once: true});
    iframe.src = src;
    document.body.append(iframe);
  });
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
