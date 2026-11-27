# Any copyright is dedicated to the Public Domain.
# http://creativecommons.org/publicdomain/zero/1.0/

import copy
import json
import sys
from pathlib import Path

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


def test_property_named_ref_is_not_a_ref():
    schema = {"$id": SCHEMA_ID, "properties": {"$ref": {"type": "string"}}}

    make_schemas.patch_schema(schema, bundled_id=BUNDLED_ID)

    assert schema["properties"]["$ref"] == {"type": "string"}


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
