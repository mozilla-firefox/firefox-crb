/**
 * Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

// The format DekNameCodec builds, spelled out so a change to it fails here.
function dekName(origin, clientType) {
  return (
    "dom-quota:" +
    ["profile", origin, "bottle", clientType, "db"]
      .map(part => `${part.length}:${part}`)
      .join(":")
  );
}

/* exported testSteps */
async function testSteps() {
  {
    const clientType = {};
    const principal = Services.qms.decodeDekName(
      dekName("https://example.com^userContextId=2", "idb"),
      clientType
    );
    Assert.equal(
      principal.origin,
      "https://example.com^userContextId=2",
      "Correct origin"
    );
    Assert.equal(clientType.value, "idb", "Correct client type");
  }

  {
    const clientType = {};
    const principal = Services.qms.decodeDekName(
      dekName("chrome", "ls"),
      clientType
    );
    Assert.ok(principal.isSystemPrincipal, "Correct principal");
    Assert.equal(clientType.value, "ls", "Correct client type");
  }

  for (const name of [
    // A DEK of another component.
    "places.sqlite",
    // A negative, an overlong and a non-numeric length.
    "dom-quota:-4:",
    "dom-quota:99:profile",
    "dom-quota:x:profile",
    // Too few parts, then too many.
    "dom-quota:7:profile",
    dekName("https://example.com", "idb") + ":5:extra",
    // An origin QuotaManager does not accept.
    dekName("not an origin", "idb"),
  ]) {
    const clientType = {};
    Assert.equal(
      Services.qms.decodeDekName(name, clientType),
      null,
      `No principal for ${name}`
    );
    Assert.equal(clientType.value, null, `No client type for ${name}`);
  }
}
