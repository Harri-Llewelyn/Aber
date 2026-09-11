"""
Payload conformance: what a device sent, judged against what its bound schemas permit.

Pure logic over JSON Schema definitions. No MQTT, no database, no daemon state: every function
here is reachable from a unit test with literals, and ingestion.py is the only caller. The
policy -- audit by default, enforce by opt-in -- is decided there; this module only says what is
wrong and whether a finding is the kind that justifies a drop.
See ingestion/README.md -> "Schema Conformance".
"""
import re
from typing import NamedTuple

# JSON Schema type names satisfied by each Sparkplug value column. `integer` is accepted for a
# double because process_ddata casts every integer wire type to float.
_JSON_TYPES_FOR_VALUE = {
    "double": frozenset({"number", "integer"}),
    "string": frozenset({"string"}),
    "bool": frozenset({"boolean"}),
}

class MetricConstraint(NamedTuple):
    """
    What every attached schema, taken together, permits one metric to carry.

    `None` on any field means unconstrained for that facet, which is not the same as absent: a
    metric named in `required` but not in `properties` is modelled with no constraints.
    """
    types:   frozenset = None   # JSON Schema `type`, as a set of names
    enum:    frozenset = None   # `enum`, as a set of permitted scalars
    minimum: float     = None
    maximum: float     = None
    pattern: str       = None   # `pattern`, a regular expression, strings only

class ModelledSchema(NamedTuple):
    """
    The resolved schema surface for a device: what each metric may carry, and whether anything
    not named is permitted at all.

    `closed` is `additionalProperties: false` on any attached schema. It is the only thing that
    makes an unmodelled metric a rejectable fault; JSON Schema's default permits unnamed
    properties.
    """
    metrics: dict
    closed:  bool = False

def _widen(a, b, union):
    """
    Combine one facet across two schemas, permissively: `None` (unconstrained) wins, because the
    union is what the device is permitted to send.
    """
    if a is None or b is None:
        return None
    return union(a, b)

def modelled_constraints(schema_definitions):
    """
    Metric name -> MetricConstraint across every attached schema, plus whether the set is closed.

    The union across schemas mirrors modelled_metrics_across() in validate.py: a device may carry
    several submodels, and a metric modelled by any one of them is modelled.
    """
    result = {}
    closed = False

    for definition in schema_definitions or []:
        if not isinstance(definition, dict):
            continue

        # `additionalProperties: false` on ANY attached schema closes the set. Any is the right
        # quantifier: a schema saying "nothing beyond these" is an assertion about the whole
        # device, and another submodel staying silent is not a contradiction of it.
        if definition.get("additionalProperties") is False:
            closed = True

        properties = definition.get("properties")
        properties = properties if isinstance(properties, dict) else {}

        # Resolved per schema before the union. Within one schema, `required: ["M"]` beside a typed
        # `properties.M` adds no type information and must not erase it; across schemas a schema that
        # declares M with no type widens the union to unconstrained.
        this_schema = {}

        for name, spec in properties.items():
            if not isinstance(name, str):
                continue
            if not isinstance(spec, dict):
                this_schema[name] = MetricConstraint()
                continue

            declared = spec.get("type")
            if isinstance(declared, str):
                types = frozenset({declared})
            elif isinstance(declared, list):
                types = frozenset(t for t in declared if isinstance(t, str))
            else:
                types = None

            raw_enum = spec.get("enum")
            if isinstance(raw_enum, list) and raw_enum:
                enum = frozenset(v for v in raw_enum if isinstance(v, (str, int, float, bool)))
                enum = enum or None
            else:
                enum = None

            # exclusiveMinimum / exclusiveMaximum are not read: Draft 4 spells them as booleans, Draft 6+
            # as numbers, and a misread facet would reject good telemetry.
            minimum = _number_or_none(spec.get("minimum"))
            maximum = _number_or_none(spec.get("maximum"))

            pattern = spec.get("pattern")
            pattern = pattern if isinstance(pattern, str) and pattern else None

            this_schema[name] = MetricConstraint(types, enum, minimum, maximum, pattern)

        for name in definition.get("required") or []:
            if isinstance(name, str):
                this_schema.setdefault(name, MetricConstraint())

        for name, c in this_schema.items():
            if name not in result:
                result[name] = c
            else:
                prev = result[name]
                result[name] = MetricConstraint(
                    types=_widen(prev.types, c.types, lambda x, y: x | y),
                    enum=_widen(prev.enum, c.enum, lambda x, y: x | y),
                    # The widest bound survives: a floor of 0 in one schema and 10 in another
                    # permits anything at or above 0.
                    minimum=_widen(prev.minimum, c.minimum, min),
                    maximum=_widen(prev.maximum, c.maximum, max),
                    # Two patterns cannot be combined into one expression meaning "either" short of
                    # building an alternation and hoping both are well formed. Differing patterns
                    # therefore widen to unconstrained, which is the rule every other facet follows.
                    pattern=_widen(prev.pattern, c.pattern, lambda x, y: x if x == y else None),
                )

    return ModelledSchema(result, closed)

def _number_or_none(value):
    """A JSON number, or None. `True` is an int in Python and is not a bound."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)

def constraint_violations(name, value_kind, value, constraint):
    """
    Every facet of one constraint that this value fails, as (code, detail, extra) tuples.

    Pure, so it is testable with three literals. Type comes first and returns alone: a value of
    the wrong type fails `minimum` and `pattern` too, and reporting all three buries the cause.
    """
    satisfied = _JSON_TYPES_FOR_VALUE.get(value_kind, frozenset())

    if constraint.types is not None and not (satisfied & constraint.types):
        return [("type_mismatch",
                 "schema declares %s" % "/".join(sorted(constraint.types)),
                 {"expected_types": sorted(constraint.types)})]

    out = []

    if constraint.enum is not None and value not in constraint.enum:
        # Sorted on the string form: an enum may legitimately mix strings and numbers, which are
        # not orderable against each other in Python 3.
        listed = sorted(constraint.enum, key=lambda v: str(v))
        out.append(("enum_mismatch",
                    "schema permits %s" % ", ".join(repr(v) for v in listed),
                    {"permitted": [v for v in listed]}))

    # Bounds apply to numbers only. A string carrying a `minimum` in its schema is a schema fault,
    # not a telemetry fault, and comparing the two in Python 3 raises rather than answering.
    if value_kind == "double" and isinstance(value, (int, float)):
        if constraint.minimum is not None and value < constraint.minimum:
            out.append(("below_minimum",
                        "schema sets minimum %g" % constraint.minimum,
                        {"minimum": constraint.minimum}))
        if constraint.maximum is not None and value > constraint.maximum:
            out.append(("above_maximum",
                        "schema sets maximum %g" % constraint.maximum,
                        {"maximum": constraint.maximum}))

    if constraint.pattern is not None and value_kind == "string" and isinstance(value, str):
        try:
            if re.search(constraint.pattern, value) is None:
                out.append(("pattern_mismatch",
                            "schema requires a match for %s" % constraint.pattern,
                            {"pattern": constraint.pattern}))
        except re.error:
            # A stored schema carrying an invalid regular expression is the schema author's fault
            # and must not be charged to the device. Reported against the SCHEMA so it is visible,
            # and deliberately never enforced -- see enforceable_violation().
            out.append(("schema_pattern_invalid",
                        "schema pattern %s is not a valid regular expression"
                        % constraint.pattern,
                        {"pattern": constraint.pattern}))

    return out

def payload_violations(observed, dropped, modelled):
    """
    Everything wrong with one DDATA payload, as a list of audit-shaped dicts.

    `observed` -- [(metric_name, value_kind, value)] for metrics the loop accepted, where
                  value_kind is a key of _JSON_TYPES_FOR_VALUE.
    `dropped`  -- [(metric_name_or_None, code, detail)] for metrics the loop skipped.
    `modelled` -- the ModelledSchema from device_modelled_constraints(), or None to skip the
                  schema half entirely.

    Pure: every branch is reachable from a unit test with three literals.
    """
    violations = []

    for name, code, detail in dropped:
        violations.append({
            "metric": name,
            "code": code,
            "detail": detail,
            # The half that is genuinely lost. See the section header.
            "dropped": True,
        })

    if modelled is None:
        return violations

    for name, value_kind, value in observed:
        constraint = modelled.metrics.get(name)

        if constraint is None:
            violations.append({
                "metric": name,
                "code": "unmodelled_metric",
                "detail": ("no attached schema declares this metric, and one of them closes the "
                           "set with additionalProperties: false"
                           if modelled.closed else
                           "no attached schema declares this metric"),
                "observed_type": value_kind,
                "dropped": False,
            })
            continue

        for code, detail, extra in constraint_violations(name, value_kind, value, constraint):
            violations.append({
                "metric": name,
                "code": code,
                "detail": detail,
                "observed_type": value_kind,
                "dropped": False,
                **extra,
            })

    return violations

def enforceable_violation(violation, closed):
    """
    Whether this finding justifies dropping the metric, as opposed to only recording it.

      * `type_mismatch`, `enum_mismatch`, `below_minimum`, `above_maximum`, `pattern_mismatch`
        contradict a constraint the bound schema states. Enforceable.
      * `unmodelled_metric` is enforceable only when a schema closes the set with
        `additionalProperties: false`; JSON Schema's default permits unnamed properties.
      * `schema_pattern_invalid` is never enforceable: the fault is in the stored schema.
      * Anything already `dropped` was skipped by the loop for its own reasons.
    """
    if violation.get("dropped"):
        return False
    code = violation.get("code")
    if code == "unmodelled_metric":
        return bool(closed)
    return code in _ENFORCEABLE_CODES

_ENFORCEABLE_CODES = frozenset({
    "type_mismatch", "enum_mismatch", "below_minimum", "above_maximum", "pattern_mismatch",
})

def violation_signature(violations):
    """
    A hashable summary of what is wrong, ignoring how often and when: a device publishing the
    same unmodelled metric on every message has one problem, recorded once.
    """
    return frozenset((v.get("metric"), v.get("code")) for v in violations)
