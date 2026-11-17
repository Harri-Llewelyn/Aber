/**
 * The VDA 5050 vocabulary: the scalar fields of the `state` message, read from the JSON Schema the
 * VDA publishes (scripts/vocabularies/vda5050-3.0.0-state.schema).
 *
 * The schema is walked from its root, `$ref`s resolved, object properties followed and arrays not.
 * Sparkplug B has no composite type, so a list of structures (`loads`, `errors`, `actionStates`,
 * `nodeStates` and the rest) cannot be a metric, and the walk does not enter one. What it reaches is
 * every scalar leaf, by its path from the root: `driving`, `powerSupply.stateOfCharge`.
 *
 * Every leaf is then either KEPT or EXCLUDED, by name, with the reason. A leaf in neither list
 * stops the build, so a release that adds a field is read and decided on rather than absorbed.
 */

/** The scalar leaves that become vocabulary rows. */
export const KEPT = [
  'driving', 'paused', 'newBaseRequest', 'operatingMode', 'lastNodeId', 'distanceSinceLastNode',
  'velocity.vx', 'velocity.vy', 'velocity.omega',
  'powerSupply.stateOfCharge', 'powerSupply.batteryVoltage', 'powerSupply.batteryCurrent',
  'powerSupply.batteryHealth', 'powerSupply.charging', 'powerSupply.range',
  'safetyState.activeEmergencyStop', 'safetyState.fieldViolation',
  'mobileRobotPosition.x', 'mobileRobotPosition.y', 'mobileRobotPosition.theta',
  'mobileRobotPosition.mapId', 'mobileRobotPosition.localized',
  'mobileRobotPosition.localizationScore', 'mobileRobotPosition.deviationRange'
];

const HEADER = 'The message header: a device\'s identity comes from its Sparkplug topic.';
const ORDER = 'The master control\'s order flow, which Aber does not run.';

/** The scalar leaves left out, each with its reason. */
export const EXCLUDED = {
  headerId: HEADER,
  timestamp: HEADER,
  version: HEADER,
  manufacturer: HEADER,
  serialNumber: HEADER,
  orderId: ORDER,
  orderUpdateId: ORDER,
  lastNodeSequenceId: ORDER,
  'plannedPath.trajectory.degree': 'Part of the planned route\'s trajectory, a structure of lists, not a reading.'
};

/** JSON Schema type to the Sparkplug B datatype name the vocabulary records. */
export const DATATYPES = { number: 'Double', integer: 'Int64', boolean: 'Boolean', string: 'String' };

/**
 * The semantic id of a field. Minted here, because the VDA issues no concept identifiers, and shaped
 * as MTConnect's are: this deployment's namespace, pinned to the major line, then the message (the
 * kind of thing named) and the field's path. The path is one segment, dots and all.
 */
export const SEMANTIC_BASE = 'https://aber.local/semantics/vda5050/v3.0';
export const vda5050SemanticId = (path) => `${SEMANTIC_BASE}/State/${path}`;

/** Whitespace collapsed: a row is one line of SQL, which the digest and every diff rely on. */
const collapse = (value) => String(value).replace(/\s+/g, ' ').trim();

function resolve(schema, node) {
  let current = node;
  for (let depth = 0; current && current.$ref; depth += 1) {
    const match = /^#\/definitions\/([A-Za-z0-9_]+)$/.exec(current.$ref);
    const target = match && schema.definitions?.[match[1]];
    if (!target) throw new Error(`cannot resolve $ref ${current.$ref}`);
    if (depth > 8) throw new Error(`$ref chain too deep at ${current.$ref}`);
    current = target;
  }
  return current;
}

/**
 * Every scalar leaf of the schema by path, and the paths of the arrays the walk does not enter.
 * Anything it cannot read as an object, an array or a scalar of a known type stops the build.
 */
export function walkState(schema) {
  const leaves = new Map();
  const arrays = [];

  const visit = (raw, path) => {
    const node = resolve(schema, raw);
    for (const keyword of ['oneOf', 'anyOf', 'allOf', 'not']) {
      if (node[keyword]) throw new Error(`${path || '(root)'}: ${keyword} is not read`);
    }
    if (node.type === 'object') {
      if (!node.properties) throw new Error(`${path || '(root)'}: an object with no properties`);
      for (const [name, child] of Object.entries(node.properties)) visit(child, path ? `${path}.${name}` : name);
    } else if (node.type === 'array') {
      arrays.push(path);
    } else if (DATATYPES[node.type]) {
      leaves.set(path, node);
    } else {
      throw new Error(`${path}: type ${JSON.stringify(node.type)} is not one of ${Object.keys(DATATYPES).join(', ')}`);
    }
  };
  visit(schema, '');
  return { leaves, arrays };
}

/**
 * The vocabulary rows, in path order: `{ name, datatype, unit, description, permittedValues,
 * semanticId }`. `name` is the field's path in the `state` message. `unit` is the schema's own
 * `unit` keyword, as the VDA writes it (`m/s`), and is not an MTConnect unit name. A field with no
 * description in the schema has none here.
 */
export function vocabularyRows(schema) {
  if (schema?.title !== 'state' || schema?.subtopic !== '/state') {
    throw new Error('this is not the VDA 5050 state schema');
  }
  const { leaves, arrays } = walkState(schema);

  for (const path of KEPT) {
    if (arrays.includes(path)) throw new Error(`${path} is an array: Sparkplug B has no composite type`);
    if (!leaves.has(path)) throw new Error(`${path} is kept and is not a scalar leaf of the schema`);
    if (path in EXCLUDED) throw new Error(`${path} is both kept and excluded`);
  }
  for (const path of Object.keys(EXCLUDED)) {
    if (!leaves.has(path)) throw new Error(`${path} is excluded and is not a scalar leaf of the schema`);
  }
  const undecided = [...leaves.keys()].filter(path => !KEPT.includes(path) && !(path in EXCLUDED));
  if (undecided.length) {
    throw new Error(`scalar leaves this generator has no decision for: ${undecided.join(', ')}`);
  }

  return [...KEPT].sort((a, b) => a.localeCompare(b)).map((path) => {
    const leaf = leaves.get(path);
    if (leaf.enum !== undefined) {
      const ok = Array.isArray(leaf.enum) && leaf.enum.length > 0 &&
        leaf.enum.every(v => typeof v === 'string' && /^[A-Za-z0-9_]+$/.test(v));
      if (!ok || leaf.type !== 'string') throw new Error(`${path}: an enum of anything but plain words`);
    }
    return {
      name: path,
      datatype: DATATYPES[leaf.type],
      unit: leaf.unit ? collapse(leaf.unit) : null,
      description: leaf.description ? collapse(leaf.description) : null,
      permittedValues: leaf.enum ? [...leaf.enum] : null,
      semanticId: vda5050SemanticId(path)
    };
  });
}
