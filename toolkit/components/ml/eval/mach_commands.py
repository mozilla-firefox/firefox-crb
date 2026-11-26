# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

try:
    import tomllib
# FIXME: remove fallback once python3.11 is the lowest supported
except ImportError:
    import tomli as tomllib
from mach.decorators import Command, CommandArgument, SubCommand
from mach.util import get_state_dir
from mozbuild.base import MachCommandBase

ON_TRY = "MOZ_AUTOMATION" in os.environ
IS_WINDOWS = sys.platform == "win32"


def _dispatch_perftest(mach_context, test_path: str, extra_args: Optional[list] = None):
    perftest_args = [test_path]

    if extra_args:
        # Strip leading dashes so mochitest args match perftest expectations.
        extra_args = [arg.lstrip("-") for arg in extra_args]
        perftest_args.extend(["--mochitest-extra-args", *extra_args])

    # Forward directly to perftest with translated mochitest arguments.
    return mach_context.commands.dispatch(
        "perftest",
        mach_context,
        perftest_args,
    )


class EvalCommand(MachCommandBase):
    """Forward eval runs to mozperftest and mochitests."""

    @Command(
        "eval",
        category="testing",
        description="Run evaluation tests, backed by perftests and mochitests.",
    )
    @CommandArgument(
        "test_path",
        help="The path to an individual .js test or a .toml manifest relative to the "
        "repo root. The test must be an evaluation test located in a browser_eval folder.",
    )
    @CommandArgument(
        "extra_args",
        nargs=argparse.REMAINDER,
        help="Additional mochitest arguments passed through to perftest.",
    )
    def run_eval(self, test_path: str, extra_args: Optional[list] = None):
        if Path(test_path).is_dir():
            test_path = str(Path(test_path) / "eval.toml")
        if Path(test_path).suffix not in (".js", ".toml"):
            print(
                "Error: test_path must be a .js test file or a .toml manifest or a dir with an eval.toml."
            )
            return 1
        if not Path(test_path).exists():
            print(f"Error: {test_path} does not exist.")
            return 1
        if test_path.endswith(".toml"):
            with open(test_path, "rb") as f:
                manifest = tomllib.load(f)
            toml_dir = Path(test_path).resolve().parent
            test_files = [
                str(toml_dir / key) for key in manifest if key.endswith(".js")
            ]
            print(f"Discovered {len(test_files)} test(s) in manifest {test_path}:")
            for test_file in test_files:
                print(f"  {test_file}")
            if not test_files:
                print(f"No JavaScript tests found in {test_path}")
                return 1
            result = 0
            for test_file in test_files:
                r = _dispatch_perftest(self._mach_context, test_file, extra_args)
                if r:
                    return r
            return result

        return _dispatch_perftest(self._mach_context, test_path, extra_args)


MARIONETTE_STARTUP_TIMEOUT = 60
FXA_TOKEN_TIMEOUT = 60
FIREFOX_QUIT_TIMEOUT = 30

# Matches the client and scope the load tests use, which MLPA accepts.
FXA_CLIENT_ID = "5882386c6d801776"
FXA_SCOPE = "profile"
FXA_OAUTH_TOKEN_URL = "https://oauth.accounts.firefox.com/v1/token"

# Runs in the browser's privileged scope and trades the signed-in session for a
# long-lived refresh token through an offline OAuth grant with PKCE.
FXA_REFRESH_TOKEN_SCRIPT = """
const [clientId, scope, resolve] = arguments;
(async () => {
  const { FxAccounts, getFxAccountsSingleton } = ChromeUtils.importESModule(
    "resource://gre/modules/FxAccounts.sys.mjs"
  );
  const fxAccounts = getFxAccountsSingleton();
  const user = await fxAccounts.getSignedInUser();
  if (!user || !user.verified) {
    // The Smart Window sign-in flow, which doesn't turn on Sync.
    const signInUrl = await FxAccounts.config.promiseConnectAccountURI(
      "smartwindow",
      "smartwindow"
    );
    return { error: user ? "unverified" : "not-signed-in", signInUrl };
  }
  const base64Url = bytes =>
    btoa(String.fromCharCode(...bytes))
      .replace(/\\+/g, "-")
      .replace(/\\//g, "_")
      .replace(/=+$/, "");
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    )
  );
  return fxAccounts._withSessionToken(async sessionToken => {
    const client = fxAccounts._internal.fxAccountsClient;
    const { code } = await client.oauthAuthorize(sessionToken, {
      client_id: clientId,
      state: base64Url(crypto.getRandomValues(new Uint8Array(16))),
      scope,
      access_type: "offline",
      code_challenge_method: "S256",
      code_challenge: challenge,
    });
    const { refresh_token } = await client.oauthToken(
      sessionToken,
      code,
      verifier,
      clientId
    );
    return { refreshToken: refresh_token };
  });
})().then(resolve, e => resolve({ error: String(e.message || e) }));
"""


def _eval_tools_profile_dir():
    profile = Path(get_state_dir()) / "eval-tools" / "profile"
    profile.mkdir(parents=True, exist_ok=True)
    return profile


def _firefox_command(binary, profile, *args):
    command = [binary, "-no-remote", "-profile", str(profile)]
    if IS_WINDOWS:
        # firefox.exe is a launcher process that exits once the browser starts.
        command.append("--wait-for-browser")
    return [*command, *args]


def _sign_in_with_firefox(binary, profile, sign_in_url):
    print(
        "\nA Firefox window will open. Sign in to your Mozilla account there, "
        "complete any email or two-factor confirmation, then quit Firefox."
    )
    subprocess.run(_firefox_command(binary, profile, sign_in_url), check=False)


def _profile_in_use(profile):
    if IS_WINDOWS:
        # Firefox holds parent.lock open without sharing while it runs.
        lock_path = profile / "parent.lock"
        if not lock_path.exists():
            return False
        try:
            with open(lock_path, "a"):
                return False
        except PermissionError:
            return True

    import fcntl

    lock_path = profile / ".parentlock"
    if not lock_path.exists():
        return False
    with open(lock_path, "a") as lock_file:
        try:
            fcntl.lockf(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return True
        fcntl.lockf(lock_file, fcntl.LOCK_UN)
    return False


def _wait_for_profile_unlock(profile):
    # On macOS a restarting Firefox detaches from the process we launched, so
    # the profile can still be open after that process exits.
    if not _profile_in_use(profile):
        return
    print(f"\nFirefox is still running on {profile}. Quit Firefox to continue.")
    while _profile_in_use(profile):
        time.sleep(1)


def _wait_for_marionette_port(proc, port_file):
    deadline = time.monotonic() + MARIONETTE_STARTUP_TIMEOUT
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("Firefox exited before Marionette started.")
        try:
            return int(port_file.read_text())
        except (FileNotFoundError, ValueError):
            time.sleep(0.5)
    raise RuntimeError("Timed out waiting for Marionette to start.")


def _query_fxa_refresh_token(binary, profile):
    """Returns a dict with a "refreshToken", or an "error" plus a "signInUrl"
    when sign-in is needed.
    """
    from marionette_driver.marionette import Marionette

    _wait_for_profile_unlock(profile)
    port_file = profile / "MarionetteActivePort"
    port_file.unlink(missing_ok=True)
    # WebDriver's recommended prefs point FxA at a dummy server.
    (profile / "user.js").write_text(
        'user_pref("marionette.port", 0);\n'
        'user_pref("remote.prefs.recommended", false);\n'
    )

    env = dict(os.environ, MOZ_HEADLESS="1", MOZ_REMOTE_ALLOW_SYSTEM_ACCESS="1")
    proc = subprocess.Popen(
        _firefox_command(binary, profile, "-marionette"),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    quit_requested = False
    try:
        port = _wait_for_marionette_port(proc, port_file)
        client = Marionette(host="127.0.0.1", port=port)
        client.start_session()
        client.set_context(client.CONTEXT_CHROME)
        client.timeout.script = FXA_TOKEN_TIMEOUT
        result = client.execute_async_script(
            FXA_REFRESH_TOKEN_SCRIPT, script_args=[FXA_CLIENT_ID, FXA_SCOPE]
        )
        try:
            client.execute_script(
                "Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);"
            )
            quit_requested = True
        except Exception:
            pass
        return result
    finally:
        try:
            proc.wait(timeout=FIREFOX_QUIT_TIMEOUT if quit_requested else 0)
        except subprocess.TimeoutExpired:
            proc.terminate()
            try:
                proc.wait(timeout=FIREFOX_QUIT_TIMEOUT)
            except subprocess.TimeoutExpired:
                proc.kill()


def _refresh_token_path():
    return Path(get_state_dir()) / "eval-tools" / "fxa_refresh_token"


def _write_private_file(path, text):
    path = Path(path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    if hasattr(os, "fchmod"):
        os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    return path


def _bootstrap_refresh_token(mach_cmd):
    """Signs in with a local Firefox build, saves a refresh token, and returns
    the path it was saved to.
    """
    try:
        binary = mach_cmd.get_binary_path()
    except Exception as exception:
        raise RuntimeError(
            f"Could not find a Firefox build ({exception}). Run ./mach build first."
        ) from exception

    profile = _eval_tools_profile_dir()
    result = _query_fxa_refresh_token(binary, profile)
    if result.get("signInUrl"):
        _sign_in_with_firefox(binary, profile, result["signInUrl"])
        result = _query_fxa_refresh_token(binary, profile)

    if not result.get("refreshToken"):
        raise RuntimeError(
            f"Could not get a Mozilla account refresh token: {result.get('error')}. "
            f"If the account session has expired, delete {profile} and run this "
            "command again."
        )
    return _write_private_file(_refresh_token_path(), result["refreshToken"])


def _read_refresh_token():
    if os.environ.get("MOZ_FXA_REFRESH_TOKEN"):
        return os.environ["MOZ_FXA_REFRESH_TOKEN"].strip()
    path = _refresh_token_path()
    if path.exists():
        return path.read_text().strip()
    return None


def _get_fxa_access_token(refresh_token):
    request = urllib.request.Request(
        FXA_OAUTH_TOKEN_URL,
        method="POST",
        headers={"Content-Type": "application/json"},
        data=json.dumps({
            "client_id": FXA_CLIENT_ID,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "scope": FXA_SCOPE,
        }).encode(),
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read())["access_token"]
    except urllib.error.HTTPError as exception:
        try:
            message = json.loads(exception.read()).get("message", "")
        except ValueError:
            message = ""
        raise RuntimeError(
            f"The FxA OAuth server rejected the refresh token "
            f"(HTTP {exception.code}: {message}). Run ./mach eval-tools login "
            "--bootstrap to get a new one."
        ) from None


def _write_env_file(path, tokens):
    return _write_private_file(
        path,
        "".join(
            f"export {name}={shlex.quote(value)}\n" for name, value in tokens.items()
        ),
    )


def _get_mlpa_token():
    project_id = "moz-fx-llm-proxy-nonprod-fd0e"
    environment = "stage"
    secret_name = f"{environment}-gke-app-secrets"
    url = (
        f"https://secretmanager.googleapis.com/v1"
        f"/projects/{project_id}/secrets/{secret_name}/versions/latest:access"
    )
    access_token = subprocess.check_output(
        ["gcloud", "auth", "print-access-token"], text=True
    ).strip()
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {access_token}"}
    )
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
    import base64

    payload = json.loads(base64.b64decode(data["payload"]["data"]))
    token = payload["mlpa-experimentation-authorization-token"]
    return token


class EvalToolsCommand(MachCommandBase):
    """Helper utilities for eval workflows."""

    @Command(
        "eval-tools",
        category="testing",
        description="Helper utilities for ML evals.",
    )
    def eval_tools(self):
        print("Eval helper utilities.\n\nRun `./mach eval-tools --help` for details.")
        return 0

    @SubCommand(
        "eval-tools",
        "login",
        description="Fetch the eval tokens, using a saved Mozilla account "
        "refresh token.",
    )
    @CommandArgument(
        "--bootstrap",
        action="store_true",
        help="Sign in to the eval test account with a local Firefox build and "
        "save a refresh token. Only needed once.",
    )
    @CommandArgument(
        "--write-env-file",
        metavar="PATH",
        help="Write the tokens as shell exports to PATH (mode 0600) instead of "
        "printing them. Load them with `source PATH`.",
    )
    def eval_tools_login(
        self, bootstrap: bool = False, write_env_file: Optional[str] = None
    ):
        if ON_TRY:
            print("This command is not intended to be run in try/CI environments.")
            return 1

        tokens = {}
        if os.environ.get("MOZ_FXA_BEARER_TOKEN") and not bootstrap:
            print("MOZ_FXA_BEARER_TOKEN already set; skipping login.")
            print("Unset with:\nunset MOZ_FXA_BEARER_TOKEN")
            tokens["MOZ_FXA_BEARER_TOKEN"] = os.environ["MOZ_FXA_BEARER_TOKEN"]
        else:
            try:
                if bootstrap:
                    path = _bootstrap_refresh_token(self)
                    print(f"Saved the refresh token to {path}.")
                refresh_token = _read_refresh_token()
                if not refresh_token:
                    print(
                        "No Mozilla account refresh token. Run ./mach eval-tools "
                        "login --bootstrap once, or set MOZ_FXA_REFRESH_TOKEN."
                    )
                    return 1
                tokens["MOZ_FXA_BEARER_TOKEN"] = _get_fxa_access_token(refresh_token)
            except Exception as exception:
                print(f"Error during FXA login: {exception}")
                return 1

        mlpa_failed = False
        if os.environ.get("MOZ_MLPA_AUTHORIZATION_TOKEN"):
            print(
                "MOZ_MLPA_AUTHORIZATION_TOKEN already set; skipping MLPA token fetch."
            )
            print("Unset with:\nunset MOZ_MLPA_AUTHORIZATION_TOKEN")
            tokens["MOZ_MLPA_AUTHORIZATION_TOKEN"] = os.environ[
                "MOZ_MLPA_AUTHORIZATION_TOKEN"
            ]
        else:
            try:
                tokens["MOZ_MLPA_AUTHORIZATION_TOKEN"] = _get_mlpa_token()
            except Exception as exception:
                print(f"Error fetching MLPA token: {exception}")
                mlpa_failed = True

        if os.environ.get("MOZ_MLPA_FASTLY_TOKEN"):
            tokens["MOZ_MLPA_FASTLY_TOKEN"] = os.environ["MOZ_MLPA_FASTLY_TOKEN"]
        else:
            print("MOZ_MLPA_FASTLY_TOKEN is not set; the evals require it.")

        if write_env_file:
            env_path = _write_env_file(write_env_file, tokens)
            print(f"\nWrote {', '.join(tokens)} to {env_path}. Load with:\n")
            print(f" source {shlex.quote(str(env_path))}")
        else:
            print(
                "\nCopy and paste the following in your terminal to persist your login:\n"
            )
            for name, value in tokens.items():
                print(f" export {name}={shlex.quote(value)}")
        return 1 if mlpa_failed else 0
