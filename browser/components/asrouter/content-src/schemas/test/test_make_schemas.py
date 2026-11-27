# Any copyright is dedicated to the Public Domain.
# http://creativecommons.org/publicdomain/zero/1.0/

import copy
import json
import sys
from pathlib import Path

import jsonschema
import mozunit
import pytest

SCHEMAS_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(SCHEMAS_DIR))

import make_schemas

SCHEMA_ID = "file:///Test.schema.json"
BUNDLED_ID = "chrome://browser/content/asrouter/schemas/Bundled.schema.json"

REF = {"$ref": "#/$defs/foo"}

NESTED_REF_CASES = {
    "properties": {"properties": {"a": REF}},
    "items": {"items": REF},
    "items-array": {"items": [{"type": "string"}, REF]},
    "prefixItems": {"prefixItems": [REF]},
    "additionalProperties": {"additionalProperties": REF},
    "patternProperties": {"patternProperties": {"^x-": REF}},
    "dependentSchemas": {"dependentSchemas": {"a": REF}},
    "contains": {"contains": REF},
    "propertyNames": {"propertyNames": REF},
    "if": {"if": REF},
    "then": {"then": REF},
    "else": {"else": REF},
    "not": {"not": REF},
    "allOf": {"allOf": [REF]},
    "anyOf": {"anyOf": [REF]},
    "oneOf": {"oneOf": [REF]},
    "nested-$defs": {"$defs": {"a": {"$defs": {"b": REF}}}},
    "sibling-of-$ref": {"$ref": "#/$defs/a", "properties": {"b": REF}},
}


@pytest.mark.parametrize(
    "schema", NESTED_REF_CASES.values(), ids=NESTED_REF_CASES.keys()
)
def test_nested_ref_is_rewritten(schema):
    schema = {"$id": SCHEMA_ID, **copy.deepcopy(schema)}

    make_schemas.patch_schema(schema, bundled_id=BUNDLED_ID)

    patched = json.dumps(schema)
    assert '"#/' not in patched
    assert f'"{SCHEMA_ID}#/$defs/foo"' in patched


@pytest.mark.parametrize(
    "ref,expected",
    [
        ("#/$defs/foo", f"{SCHEMA_ID}#/$defs/foo"),
        ("file:///FxMSCommon.schema.json#/$defs/foo", f"{BUNDLED_ID}#/$defs/foo"),
        (
            "file:///MultiStageProtonScreenSchemas.json#/$defs/foo",
            f"{BUNDLED_ID}#/$defs/MultiStageProtonScreen/$defs/foo",
        ),
        (
            "file:///MultiStageProtonScreenSchemas.json",
            f"{BUNDLED_ID}#/$defs/MultiStageProtonScreen",
        ),
        (
            "file:///MultiStageProtonScreenSchemas.json#/properties/id",
            f"{BUNDLED_ID}#/$defs/MultiStageProtonScreen/properties/id",
        ),
        (
            "file:///Other.schema.json#/$defs/foo",
            "file:///Other.schema.json#/$defs/foo",
        ),
        (f"{BUNDLED_ID}#/$defs/foo", f"{BUNDLED_ID}#/$defs/foo"),
    ],
)
def test_ref_is_rewritten(ref, expected):
    schema = {"$id": SCHEMA_ID, "$ref": ref}

    make_schemas.patch_schema(schema, bundled_id=BUNDLED_ID)

    assert schema["$ref"] == expected


def test_schema_id_override():
    schema = {"$id": SCHEMA_ID, "$ref": "#/$defs/foo"}

    make_schemas.patch_schema(schema, bundled_id=BUNDLED_ID, schema_id=BUNDLED_ID)

    assert schema["$ref"] == f"{BUNDLED_ID}#/$defs/foo"


def test_screen_schema_relative_ref_is_nested_under_screen():
    schema = {
        "$id": "file:///MultiStageProtonScreenSchemas.json",
        "$ref": "#/$defs/foo",
    }

    make_schemas.patch_schema(schema, bundled_id=BUNDLED_ID)

    assert schema["$ref"] == f"{BUNDLED_ID}#/$defs/MultiStageProtonScreen/$defs/foo"


def test_property_named_ref_is_not_a_ref():
    """A property named `$ref` holds that property's schema, not a reference."""
    schema = {
        "$id": SCHEMA_ID,
        "type": "object",
        "properties": {
            "$ref": {"type": "string"},
            "link": {"$ref": "#/$defs/foo"},
        },
    }

    make_schemas.patch_schema(schema, bundled_id=BUNDLED_ID)

    assert schema["properties"]["$ref"] == {"type": "string"}
    assert schema["properties"]["link"]["$ref"] == f"{SCHEMA_ID}#/$defs/foo"


def test_screen_schema_is_bundled(monkeypatch):
    monkeypatch.chdir(SCHEMAS_DIR)
    schema_def = next(d for d in make_schemas.SCHEMAS if d.bundle_screen)
    bundled = make_schemas.bundle_schema(schema_def)
    screen_defs = make_schemas.read_schema(make_schemas.SCREEN_SCHEMA_PATH)["$defs"]
    bundled_screen = bundled["$defs"][make_schemas.SCREEN_DEF_NAME]

    assert bundled_screen["$defs"].keys() == screen_defs.keys()
    assert not screen_defs.keys() & bundled["$defs"].keys()

    resolver = make_schemas.NestedRefResolver(bundled)
    screen_schema = {
        "$ref": f"{schema_def.schema_id}#/$defs/{make_schemas.SCREEN_DEF_NAME}"
    }
    screen = {
        "id": "SCREEN",
        "content": {"primary_button": {"label": {"string_id": "label"}}},
    }
    jsonschema.validate(instance=screen, schema=screen_schema, resolver=resolver)

    screen["content"]["primary_button"]["label"] = 1
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(instance=screen, schema=screen_schema, resolver=resolver)


@pytest.mark.parametrize("schema_def", make_schemas.SCHEMAS, ids=lambda d: d.schema_id)
def test_generated_schema_refs_resolve(monkeypatch, schema_def):
    monkeypatch.chdir(SCHEMAS_DIR)

    make_schemas.check_refs(make_schemas.bundle_schema(schema_def))


def test_unresolvable_ref_is_an_error():
    schema = {
        "$id": BUNDLED_ID,
        "$defs": {"foo": {"type": "string"}},
        "properties": {"a": {"$ref": f"{BUNDLED_ID}#/$defs/missing"}},
    }

    with pytest.raises(ValueError, match="#/\\$defs/missing"):
        make_schemas.check_refs(schema)


if __name__ == "__main__":
    mozunit.main()
