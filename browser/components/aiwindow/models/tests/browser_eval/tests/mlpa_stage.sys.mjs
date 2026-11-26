/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

// Evals must not send traffic to prod MLPA. The stage gateway is reached
// directly rather than through Fastly so that CI is not blocked.
const MLPA_STAGE_BASE_URL =
  "https://mlpa-gateway-stage.llm-proxy.nonprod.dataservices.mozgcp.net/v1";

const REQUIRED_TOKENS = [
  "MOZ_FXA_BEARER_TOKEN",
  "MOZ_MLPA_AUTHORIZATION_TOKEN",
  "MOZ_MLPA_FASTLY_TOKEN",
];

/**
 * Reads the eval tokens and returns the prefs that point Smart Window at stage
 * MLPA. Throws if any token is missing.
 *
 * @returns {{fxaToken: string, prefs: Array<[string, string]>}}
 */
export function getMlpaStageConfig() {
  const missing = REQUIRED_TOKENS.filter(name => !Services.env.get(name));
  if (missing.length) {
    throw new Error(
      `${missing.join(", ")} must be set in the environment. Run ./mach eval-tools login for MOZ_FXA_BEARER_TOKEN.`
    );
  }
  const fxaToken = Services.env.get("MOZ_FXA_BEARER_TOKEN");
  return {
    fxaToken,
    prefs: [
      ["browser.smartwindow.apiKey", fxaToken],
      ["browser.smartwindow.endpoint", MLPA_STAGE_BASE_URL],
      [
        "browser.smartwindow.searchQuery.endpointURL",
        `${MLPA_STAGE_BASE_URL}/search`,
      ],
      [
        "browser.smartwindow.extraHeaders",
        JSON.stringify({
          "service-type": "mochi-dev",
          "x-dev-authorization": Services.env.get(
            "MOZ_MLPA_AUTHORIZATION_TOKEN"
          ),
          "X-Fastly-Request": Services.env.get("MOZ_MLPA_FASTLY_TOKEN"),
        }),
      ],
    ],
  };
}
