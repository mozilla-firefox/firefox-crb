# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, # You can obtain one at http://mozilla.org/MPL/2.0/.

from __future__ import annotations

import functools
import io
import json
import mimetypes
import os
import sys
from concurrent import futures
from typing import TYPE_CHECKING

import requests
from google.cloud import storage

if TYPE_CHECKING:
    from mozpack.files import BaseFile

# Each upload is a small file that mostly waits on the request round trip, so
# many requests in flight keep the upload short on workers far from the bucket.
UPLOAD_THREADS = 128
# Keep the CDN from serving stale docs for long after a publish (bug 2094139).
CACHE_CONTROL = "public, max-age=300"
# GCS batch requests are limited to 100 calls.
DELETE_BATCH_SIZE = 100

# Buckets of the data-static-websites projects, set up in SREIN-2061. Levels 1
# and 2 upload previews to stage, level 3 publishes to prod.
STAGE_BUCKET = "moz-fx-data-static-websit-f7e0-firefox-source-docs"
PROD_BUCKET = "moz-fx-data-static-websit-8565-firefox-source-docs"
SECRET_NAME = "firefox-source-docs-upload"
SECRET_KEY_FIELD = "GCP_SERVICE_ACCOUNT_KEY"


@functools.cache
def get_service_account(level):
    print("Using GCP credentials from the secrets service")
    secrets_url = (
        "http://taskcluster/secrets/v1/secret/"
        f"project/releng/gecko/build/level-{level}/{SECRET_NAME}"
    )
    res = requests.get(secrets_url)
    res.raise_for_status()
    secret = res.json()["secret"]
    # The secret is either the service account key itself or wraps it.
    if "private_key" in secret:
        return secret
    if SECRET_KEY_FIELD not in secret:
        raise KeyError(
            f"{SECRET_NAME} has neither a private_key nor a {SECRET_KEY_FIELD} field, "
            f"it has: {', '.join(sorted(secret)) or 'none'}"
        )
    key = secret[SECRET_KEY_FIELD]
    return json.loads(key) if isinstance(key, str) else key


@functools.cache
def create_gcs_bucket(purpose):
    """Return a bucket handle backed by a client dedicated to ``purpose``.

    The prune task runs alongside the uploads, so it gets its own client to
    keep its batched deletions out of the upload connection pool.
    """
    level = os.environ.get("MOZ_SCM_LEVEL", "1")
    bucket_name = PROD_BUCKET if level == "3" else STAGE_BUCKET

    if "TASK_ID" in os.environ:
        client = storage.Client.from_service_account_info(get_service_account(level))
    else:
        print("Trying to use your GCP application default credentials..")
        client = storage.Client()

    adapter = requests.adapters.HTTPAdapter(
        pool_connections=UPLOAD_THREADS, pool_maxsize=UPLOAD_THREADS
    )
    client._http.mount("https://", adapter)

    return client.bucket(bucket_name)


@functools.cache
def get_gcs_keys(bucket, include_prefix=None, exclude_prefix=None):
    # When exclude_prefix is set, enumerate one level at a time with a
    # delimiter and skip that subtree, descending into the other prefixes.
    # Listing the whole bucket is prohibitively slow because every build
    # leaves an immutable per-build copy under main/.
    kwargs = {"prefix": include_prefix}
    if exclude_prefix is not None:
        _, sep, rest = exclude_prefix.partition("/")
        assert sep and not rest, "exclude_prefix must be a single top-level prefix"
        kwargs["delimiter"] = "/"
    blobs = bucket.client.list_blobs(bucket, **kwargs)
    all_keys = [blob.name for blob in blobs]
    for prefix in blobs.prefixes:
        if prefix != exclude_prefix:
            all_keys.extend(get_gcs_keys(bucket, include_prefix=prefix))

    return all_keys


def gcs_delete_missing(files, key_prefix=None):
    """Delete files in the GCS bucket.

    Delete files on the GCS bucket that doesn't match the files
    given as the param. If the key_prefix is not specified, missing
    files that has main/ as a prefix will be removed. Otherwise, it
    will remove files with the same prefix as key_prefix.
    """
    bucket = create_gcs_bucket("prune")
    if key_prefix:
        files_on_server = get_gcs_keys(bucket, include_prefix=key_prefix)
    else:
        files_on_server = get_gcs_keys(bucket, exclude_prefix="main/")
    files = {key_prefix + "/" + path if key_prefix else path for path, f in files}
    files_to_delete = [path for path in files_on_server if path not in files]

    for i in range(0, len(files_to_delete), DELETE_BATCH_SIZE):
        keys = files_to_delete[i : i + DELETE_BATCH_SIZE]
        with bucket.client.batch():
            for key in keys:
                bucket.delete_blob(key)
        for key in keys:
            print(f"deleted {key}")


def gcs_upload(
    files: list[tuple[str, BaseFile]], key_prefix: str | None = None
) -> None:
    """Upload files to a GCS bucket.

    Keys in the bucket correspond to source filenames. If ``key_prefix`` is
    defined, key names will be ``<key_prefix>/<path>``.

    Pruning of stale keys (gcs_delete_missing) runs concurrently with the
    uploads instead of after them. Listing the bucket is network-bound and
    slow, but it is independent of the uploads: uploads only ever write keys
    that are present in ``files``, while the prune only ever removes keys that
    are *not* in ``files``, so the two operate on disjoint key sets and their
    relative ordering doesn't affect the result.
    """
    bucket = create_gcs_bucket("upload")

    def upload(f, path, key, content_type, content_encoding):
        # Need to flush to avoid buffering/interleaving from multiple threads.
        sys.stdout.write(f"uploading {path} to {key}\n")
        sys.stdout.flush()
        blob = bucket.blob(key)
        blob.cache_control = CACHE_CONTROL
        blob.content_encoding = content_encoding
        # The file types returned by mozpack behave like file objects. But
        # they don't accept an argument to read(). So we wrap in a BytesIO.
        blob.upload_from_file(io.BytesIO(f.read()), content_type=content_type)

    fs = []
    # One extra worker for the prune task on top of the upload workers.
    with futures.ThreadPoolExecutor(UPLOAD_THREADS + 1) as e:
        # Kick off the (slow) prune first so its bucket listing overlaps with
        # the uploads rather than blocking after them.
        delete_future = e.submit(gcs_delete_missing, files, key_prefix)

        for path, f in files:
            content_type, content_encoding = mimetypes.guess_type(path)
            if content_type and content_type.startswith("text/"):
                content_type += '; charset="utf-8"'

            if key_prefix:
                key = f"{key_prefix}/{path}"
            else:
                key = path

            fs.append(e.submit(upload, f, path, key, content_type, content_encoding))

    # Need to do this to catch any exceptions.
    delete_future.result()
    for f in fs:
        f.result()
