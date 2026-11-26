# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import json
import os
from copy import deepcopy

import dpath

from condprof.util import logger

HERE = os.path.dirname(__file__)


def get_customizations():
    for f in os.listdir(HERE):
        if not f.endswith("json"):
            continue
        yield os.path.join(HERE, f)


def _parse_json(maybe_json):
    try:
        return json.loads(maybe_json, strict=True)
    except (json.JSONDecodeError, TypeError):
        return None


def _resolve_path(path_or_name):
    """Resolve a customization name or path to an existing file path."""
    if not path_or_name.endswith(".json"):
        path_or_name += ".json"
    if os.path.exists(path_or_name):
        return path_or_name
    # trying relative
    rpath = os.path.join(HERE, path_or_name)
    if os.path.exists(rpath):
        return rpath
    return None


def _get_default_customization(scenario_name):
    """Return the DEFAULT_CUSTOMIZATION declared by a scenario module.

    The constant is read with `ast` rather than by importing the module:
    importing it pulls in condprof.scenarii, and from there arsenic and the
    rest of the profile-building stack, which callers that only need to
    resolve a customization name (raptor, lint and docs tooling) do not have.
    """
    import ast

    module_path = _scenario_module_path(scenario_name)
    if module_path is None:
        return None
    with open(module_path) as f:
        tree = ast.parse(f.read(), filename=module_path)
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if (
                    isinstance(target, ast.Name)
                    and target.id == "DEFAULT_CUSTOMIZATION"
                ):
                    return ast.literal_eval(node.value)
    return None


def _scenario_module_path(scenario_name):
    """Path of the module implementing a scenario registry name.

    Registry names may be aliases, so the `scenarii` dict and the imports in
    condprof/scenarii/__init__.py are read with `ast` to map the name to the
    module that defines its function, again without importing the package.
    """
    import ast

    scenarii_dir = os.path.join(os.path.dirname(HERE), "scenarii")
    with open(os.path.join(scenarii_dir, "__init__.py")) as f:
        tree = ast.parse(f.read())

    func_to_module = {}
    name_to_func = {}
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                func_to_module[alias.asname or alias.name] = node.module
        elif isinstance(node, ast.Assign) and isinstance(node.value, ast.Dict):
            if any(
                isinstance(t, ast.Name) and t.id == "scenarii" for t in node.targets
            ):
                for key, value in zip(node.value.keys, node.value.values):
                    if isinstance(key, ast.Constant) and isinstance(value, ast.Name):
                        name_to_func[key.value] = value.id

    func = name_to_func.get(scenario_name)
    module = func_to_module.get(func) if func else None
    if module is None:
        return None
    module_path = (
        os.path.join(os.path.dirname(os.path.dirname(HERE)), *module.split(".")) + ".py"
    )
    return module_path if os.path.exists(module_path) else None


def _split_overrides(raw_overrides):
    """Split a flat override dict into glob keys and exact dpath keys."""
    globs = {}
    overrides = {}
    for k, v in raw_overrides.items():
        if "/" in k:
            overrides[k] = v
        else:
            globs[k] = v
    return {"globs": globs, "overrides": overrides}


def find_customization(path_or_name_or_json, scenario=None):
    """Resolve a customization identifier to a (path, overrides_spec) tuple.

    The identifier can be:
    - A path to an existing .json file
    - A plain name like "default" (resolved to default.json in this directory)
    - A JSON object with optional "customization" key for the base and
      remaining keys as overrides (keys with "/" are exact dpaths, without
      "/" are glob-matched against all leaves)

    Returns (path, overrides_spec) or (None, None) if not found.
    """
    # 1. Try as path
    resolved = _resolve_path(path_or_name_or_json)
    if resolved is not None:
        return resolved, None

    # 2. Try as JSON
    parsed = _parse_json(path_or_name_or_json)
    if parsed is None or not isinstance(parsed, dict):
        return None, None

    # Extract base customization
    if "customization" in parsed:
        base_name = parsed.pop("customization")
    elif scenario is not None:
        base_name = _get_default_customization(scenario)
        if base_name is None:
            return None, None
    else:
        return None, None

    base_path = _resolve_path(base_name)
    if base_path is None:
        return None, None

    overrides_spec = _split_overrides(parsed) if parsed else None
    return base_path, overrides_spec


def _merge_scenario_steps(base_steps, override_steps):
    """Merge override scenario steps with base step defaults.

    Each override step inherits the options of the first base step with the
    same scenario name.  Keys present in the override take precedence.
    """
    base_defaults = {}
    for step in base_steps:
        for name, opts in step.items():
            if name not in base_defaults and isinstance(opts, dict):
                base_defaults[name] = opts

    merged = []
    for step in override_steps:
        merged_step = {}
        for name, opts in step.items():
            if name in base_defaults and isinstance(opts, dict):
                merged_step[name] = {**base_defaults[name], **opts}
            else:
                merged_step[name] = opts
        merged.append(merged_step)
    return merged


def apply_overrides(vanilla, overrides_spec):
    """Apply glob and exact dpath overrides to a customization dict.

    Globs are applied first (matching all leaves), then exact dpaths.
    When both old and new values are lists of single-key dicts (scenario
    steps), each override step inherits defaults from the base step with
    the same key.
    """
    customized = deepcopy(vanilla)
    for k, v in overrides_spec.get("globs", {}).items():
        if v is None:
            dpath.delete(customized, "**/" + k, glob=True)
            continue
        existing = list(dpath.search(customized, "**/" + k, yielded=True))
        if existing:
            for path, _ in existing:
                old_val = dpath.get(customized, path)
                new_val = v
                if (
                    isinstance(old_val, list)
                    and isinstance(v, list)
                    and all(isinstance(x, dict) for x in old_val)
                    and all(isinstance(x, dict) for x in v)
                ):
                    new_val = _merge_scenario_steps(old_val, v)
                dpath.set(customized, path, new_val)
        else:
            logger.warning(
                f"Override {k!r} matched nothing in the customization; "
                "adding it as a top-level key"
            )
            customized[k] = v
    for k, v in overrides_spec.get("overrides", {}).items():
        if v is None:
            dpath.delete(customized, k, glob=True)
            continue
        existing = list(dpath.search(customized, k, yielded=True))
        if not existing:
            dpath.new(customized, k, v)
        else:
            dpath.set(customized, k, v)
    return customized


def get_customization(path_or_name_or_json, scenario=None):
    path, overrides_spec = find_customization(path_or_name_or_json, scenario=scenario)
    if path is None:
        raise OSError(f"Can't find the customization file {path_or_name_or_json!r}")
    with open(path) as f:
        vanilla = json.loads(f.read())
    if overrides_spec is not None:
        return apply_overrides(vanilla, overrides_spec)
    return vanilla
