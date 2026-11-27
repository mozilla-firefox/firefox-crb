/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  Schemas: "resource://gre/modules/Schemas.sys.mjs",
});

var { ExtensionPreferencesManager } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionPreferencesManager.sys.mjs"
);

var { ExtensionError } = ExtensionUtils;

const DOH_SETTING = "dns.dohSettings";

const DOH_PREFS = [
  "network.trr.mode",
  "network.trr.uri",
  "network.trr.bootstrapAddr",
  "network.trr.excluded-domains",
];

// DoHController sets this whenever network.trr.mode or network.trr.uri change.
// It must stay last so that it is restored after those prefs on removal.
const DISABLE_HEURISTICS_PREF = "doh-rollout.disable-heuristics";

// "off" maps to MODE_TRROFF because MODE_NATIVEONLY is treated as "default" by
// the preferences UI and the DoH rollout.
const DOH_MODES = new Map([
  ["off", Ci.nsIDNSService.MODE_TRROFF],
  ["doh-first", Ci.nsIDNSService.MODE_TRRFIRST],
  ["doh-only", Ci.nsIDNSService.MODE_TRRONLY],
]);

ExtensionPreferencesManager.addSetting(DOH_SETTING, {
  permission: "proxy",
  prefNames: [...DOH_PREFS, DISABLE_HEURISTICS_PREF],

  setCallback(value) {
    return {
      "network.trr.mode": DOH_MODES.get(value.mode),
      "network.trr.uri": value.url,
      "network.trr.bootstrapAddr": value.bootstrapAddress,
      "network.trr.excluded-domains": value.excludedDomains?.join(","),
      [DISABLE_HEURISTICS_PREF]: DOH_MODES.has(value.mode) ? true : undefined,
    };
  },
});

function getDoHSettings() {
  let modePref = Services.prefs.getIntPref("network.trr.mode", 0);
  let mode = "off";
  if (modePref === Ci.nsIDNSService.MODE_NATIVEONLY) {
    mode = "default";
  } else if (modePref === Ci.nsIDNSService.MODE_TRRFIRST) {
    mode = "doh-first";
  } else if (modePref === Ci.nsIDNSService.MODE_TRRONLY) {
    mode = "doh-only";
  }

  return {
    mode,
    url: Services.prefs.getStringPref("network.trr.uri", ""),
    bootstrapAddress: Services.prefs.getStringPref(
      "network.trr.bootstrapAddr",
      ""
    ),
    excludedDomains: Services.prefs
      .getStringPref("network.trr.excluded-domains", "")
      .split(",")
      .map(domain => domain.trim())
      .filter(Boolean),
  };
}

function isIPAddress(address) {
  // getBaseDomainFromHost ignores a trailing dot, the TRR service does not.
  if (address.endsWith(".")) {
    return false;
  }
  try {
    Services.eTLD.getBaseDomainFromHost(address);
  } catch (e) {
    return e.result == Cr.NS_ERROR_HOST_IS_IP_ADDRESS;
  }
  return false;
}

// The TRR service reads domain lists from comma separated prefs.
function isValidDomain(domain) {
  return /^[^\s,]+$/.test(domain);
}

function normalizeDoHConfig(extension, value) {
  let normalized = Schemas.normalize(value, "dns.DoHConfig", {
    url: extension.baseURI.spec,
    principal: extension.principal,
    manifestVersion: extension.manifestVersion,
    logError: error => extension.logWarning(error),
  });
  if (normalized.error) {
    throw new ExtensionError(
      `Invalid dns.dohSettings value: ${normalized.error}`
    );
  }

  // Missing optional properties are normalized to null.
  let config = Object.fromEntries(
    Object.entries(normalized.value).filter(([, v]) => v !== null)
  );
  let { mode, url, bootstrapAddress, excludedDomains } = config;

  if (url) {
    let parsed = URL.parse(url);
    if (!parsed?.hostname) {
      throw new ExtensionError(`${url} is not a valid url.`);
    }
    if (parsed.protocol !== "https:") {
      throw new ExtensionError("dns.dohSettings url must use https.");
    }
  }

  if (bootstrapAddress && !isIPAddress(bootstrapAddress)) {
    throw new ExtensionError(
      `${bootstrapAddress} is not a valid IP address for bootstrapAddress.`
    );
  }

  if (excludedDomains) {
    for (let domain of excludedDomains) {
      if (!isValidDomain(domain)) {
        throw new ExtensionError(
          `"${domain}" is not a valid domain for excludedDomains.`
        );
      }
    }
    // The TRR service matches excluded domains against lowercased hostnames.
    config.excludedDomains = excludedDomains.map(d => d.toLowerCase());
  }

  // The preferences UI clears network.trr.uri in the other modes.
  let usesDoH = mode == "doh-first" || mode == "doh-only";
  for (let [name, value] of Object.entries({ url, bootstrapAddress })) {
    if (value && !usesDoH) {
      throw new ExtensionError(
        `dns.dohSettings ${name} requires the doh-first or doh-only mode.`
      );
    }
  }

  return config;
}

const dnssFlags = {
  allow_name_collisions: Ci.nsIDNSService.RESOLVE_ALLOW_NAME_COLLISION,
  bypass_cache: Ci.nsIDNSService.RESOLVE_BYPASS_CACHE,
  canonical_name: Ci.nsIDNSService.RESOLVE_CANONICAL_NAME,
  disable_ipv4: Ci.nsIDNSService.RESOLVE_DISABLE_IPV4,
  disable_ipv6: Ci.nsIDNSService.RESOLVE_DISABLE_IPV6,
  disable_trr: Ci.nsIDNSService.RESOLVE_DISABLE_TRR,
  offline: Ci.nsIDNSService.RESOLVE_OFFLINE,
  priority_low: Ci.nsIDNSService.RESOLVE_PRIORITY_LOW,
  priority_medium: Ci.nsIDNSService.RESOLVE_PRIORITY_MEDIUM,
  speculate: Ci.nsIDNSService.RESOLVE_SPECULATE,
};

function getErrorString(nsresult) {
  let e = new Components.Exception("", nsresult);
  return e.name;
}

this.dns = class extends ExtensionAPI {
  getAPI(context) {
    let { extension } = context;

    // On Android, DoH is configured by the app through GeckoRuntimeSettings.
    let checkPlatform = () => {
      if (AppConstants.platform == "android") {
        throw new ExtensionError(
          "dns.dohSettings is not supported on android."
        );
      }
    };

    let dohSettings = ExtensionPreferencesManager.getSettingsAPI({
      context,
      name: DOH_SETTING,
      callback: getDoHSettings,
      validate: checkPlatform,
    });
    let { set: setDoHSettings } = dohSettings;

    return {
      dns: {
        dohSettings: Object.assign(dohSettings, {
          set: details => {
            checkPlatform();

            if (!extension.privateBrowsingAllowed) {
              throw new ExtensionError(
                "dns.dohSettings requires private browsing permission."
              );
            }

            if (DOH_PREFS.some(pref => Services.prefs.prefIsLocked(pref))) {
              throw new ExtensionError(
                "DNS over HTTPS settings are being managed by the Policies manager."
              );
            }

            return setDoHSettings({
              ...details,
              value: normalizeDoHConfig(extension, details.value),
            });
          },
        }),
        resolve: function (hostname, flags) {
          let dnsFlags = flags.reduce(
            (mask, flag) => mask | dnssFlags[flag],
            0
          );

          return new Promise((resolve, reject) => {
            let request;
            let response = {
              addresses: [],
            };
            let listener = {
              onLookupComplete: function (inRequest, inRecord, inStatus) {
                if (inRequest === request) {
                  if (!Components.isSuccessCode(inStatus)) {
                    return reject({ message: getErrorString(inStatus) });
                  }
                  inRecord.QueryInterface(Ci.nsIDNSAddrRecord);
                  if (dnsFlags & Ci.nsIDNSService.RESOLVE_CANONICAL_NAME) {
                    try {
                      response.canonicalName = inRecord.canonicalName;
                    } catch (e) {
                      // no canonicalName
                    }
                  }
                  response.isTRR = inRecord.IsTRR();
                  while (inRecord.hasMore()) {
                    let addr = inRecord.getNextAddrAsString();
                    // Sometimes there are duplicate records with the same ip.
                    if (!response.addresses.includes(addr)) {
                      response.addresses.push(addr);
                    }
                  }
                  return resolve(response);
                }
              },
            };
            try {
              request = Services.dns.asyncResolve(
                hostname,
                Ci.nsIDNSService.RESOLVE_TYPE_DEFAULT,
                dnsFlags,
                null, // AdditionalInfo
                listener,
                null,
                {} /* defaultOriginAttributes */
              );
            } catch (e) {
              // handle exceptions such as offline mode.
              return reject({ message: e.name });
            }
          });
        },
      },
    };
  }
};
