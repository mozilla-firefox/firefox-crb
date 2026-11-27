# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

from copy import deepcopy

import pytest
from mozunit import main

from gecko_taskgraph.test.conftest import FakeTransformConfig
from gecko_taskgraph.transforms import job as job_transforms  # noqa: F401
from gecko_taskgraph.util.partners import (
    fix_partner_config,
    get_partner_build_numbers,
    get_partner_config_entries,
)


@pytest.fixture
def partner_config():
    return {
        "release-partner-repack": {
            "acme": {
                "one": {
                    "locales": ["en-US"],
                    "platforms": ["linux64-shippable"],
                    "publish_to_releases": True,
                }
            },
            "other": {
                "two": {
                    "locales": ["en-US"],
                    "platforms": ["win32-shippable"],
                    "publish_to_releases": True,
                    "build_number": 4,
                }
            },
        },
        "release-partner-attribution": {
            "defaults": {},
            "configs": [
                {
                    "campaign": "acme",
                    "content": "attribution",
                    "locales": ["en-US"],
                    "platforms": ["win32-shippable"],
                    "publish_to_releases": True,
                    "build_number": 7,
                }
            ],
        },
    }


def test_partner_config_build_numbers(partner_config):
    original = deepcopy(partner_config)
    normalized = fix_partner_config(partner_config)
    config = FakeTransformConfig(
        params={"release_partner_config": normalized, "release_partners": []}
    )
    assert get_partner_build_numbers(config) == {
        "acme/one": 1,
        "other/two": 4,
        "acme/attribution": 7,
    }
    config.params["release_partners"] = ["acme"]
    assert get_partner_build_numbers(config) == {"acme/one": 1, "acme/attribution": 7}
    assert partner_config == original
    assert "other" in normalized["release-partner-repack"]


@pytest.mark.parametrize("number", [0, -1, True, 1.5, "2"])
def test_invalid_partner_build_number(partner_config, number):
    partner_config["release-partner-repack"]["acme"]["one"]["build_number"] = number
    with pytest.raises(ValueError, match="Invalid partner build number for acme/one"):
        fix_partner_config(partner_config)


def test_attribution_uploads_use_each_partner_build_number():
    from gecko_taskgraph.transforms.partner_attribution_beetmover import (
        generate_upstream_artifacts,
    )

    artifacts = [
        ("path-one", "acme", "one", "win32", "en-US"),
        ("path-two", "other", "two", "mac", "ja-JP-mac"),
    ]
    result = generate_upstream_artifacts(
        "release-partner-attribution",
        artifacts,
        "partner-repacks/{partner}/{subpartner}/v{partner_build_number}/{platform}/{locale}",
        {("acme", "one"): 3, ("other", "two"): 8},
    )
    assert [item["locale"] for item in result] == [
        "partner-repacks/acme/one/v3/win32/en-US",
        "partner-repacks/other/two/v8/mac/ja-JP-mac",
    ]


def test_push_build_numbers_are_derived_from_config(partner_config, mocker):
    from gecko_taskgraph.transforms import task

    mocker.patch.object(
        task, "get_release_config", return_value={"version": "160.0", "build_number": 2}
    )
    config = FakeTransformConfig(
        params={
            "release_partners": [],
            "release_partner_config": fix_partner_config(partner_config),
        }
    )
    result = {}
    task.build_beetmover_push_to_release_payload(
        config, {"worker": {"product": "firefox"}}, result
    )
    assert result["payload"] == {
        "product": "firefox",
        "version": "160.0",
        "build_number": 2,
        "partners": ["acme/one", "other/two", "acme/attribution"],
        "partner_build_numbers": {"acme/one": 1, "other/two": 4, "acme/attribution": 7},
    }
    for _, _, _, entry in get_partner_config_entries(
        config.params["release_partner_config"]
    ):
        entry["build_number"] = 1
    result = {}
    task.build_beetmover_push_to_release_payload(
        config, {"worker": {"product": "firefox"}}, result
    )
    assert result["payload"]["partner_build_numbers"] == {
        "acme/one": 1,
        "other/two": 1,
        "acme/attribution": 1,
    }


def test_repack_upload_uses_subpartner_build_number(partner_config, mocker):
    from gecko_taskgraph.transforms import beetmover_repackage_partner as beetmover

    mocker.patch.object(beetmover, "craft_release_properties", return_value={})
    config = FakeTransformConfig(
        kind="release-partner-repack-beetmover",
        params={
            "release_partner_config": fix_partner_config(partner_config),
            "release_partners": [],
            "build_number": 2,
            "version": "160.0",
        },
    )
    task = {
        "attributes": {
            "build_platform": "linux64-shippable",
            "artifact_prefix": "releng/partner",
        },
        "extra": {"repack_id": "other/two/en-US"},
        "dependencies": {"build": "build", "repackage-signing": "signing"},
        "partner-path": "partner-repacks/{partner}/{subpartner}/v{partner_build_number}/{platform}/{locale}",
    }
    result = list(beetmover.make_task_worker(config, [task]))[0]
    assert {item["locale"] for item in result["worker"]["upstream-artifacts"]} == {
        "partner-repacks/other/two/v4/linux-x86_64/en-US"
    }


if __name__ == "__main__":
    main()
