import { compare, lastDefinition, need, read, SCHEMA } from './lib.mjs';

// 71. The automations vocabulary, one set of patterns, names and limits in four places (0255, 0256):
// the JSON Schema the dashboard serves, automations_parse()'s constants and lists, and the CHECKs on
// the tables. A pattern the schema accepts and the function refuses is an editor that offers a file
// the database turns back; the reverse is one that refuses what the database would apply. The guard
// suite holds the two over fixtures; this holds the words and numbers that no fixture reaches.
export default function check() {
  const schema = JSON.parse(read('frontend/public/json-schema/automations.schema.json'));
  const parse = lastDefinition('CREATE OR REPLACE FUNCTION public.automations_parse(', '$$;', 'automations_parse()');
  const key = need(SCHEMA, /CONSTRAINT automations_key_format CHECK \(\(key ~ '([^']+)'::text\)\)/, 'automations_key_format in the migrations');
  const hold = need(SCHEMA, /CONSTRAINT automation_triggers_hold_valid CHECK \(\(\(hold_seconds >= 0\) AND \(hold_seconds <= (\d+)\)\)\)/,
    'automation_triggers_hold_valid in the migrations');
  const severity = need(SCHEMA, /CONSTRAINT automation_actions_alert_shape\s+CHECK \(\(\(kind <> 'alert'::text\) OR \(severity = ANY \(ARRAY\[([^\]]*)\]\)\)\)\)/,
    'automation_actions_alert_shape in the migrations');
  const platform = need(SCHEMA, /ADD CONSTRAINT platform_alerts_severity_valid CHECK \(\(severity = ANY \(ARRAY\[([^\]]*)\]\)\)\)/,
    'platform_alerts_severity_valid in the migrations');
  const constant = (name) => parse && need(parse.body.split('\n').find((line) => line.trim().startsWith(`${name} `)) ?? '',
    /CONSTANT (?:text|integer) := '?([^';]+)'?;/, `${name} in automations_parse() (${parse.file})`);
  const words = (list) => [...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).join(', ');
  const { automation, thresholdTrigger, alertAction, deviceId } = schema.$defs;
  const id = constant('c_id');
  const forPattern = constant('c_for');
  const uuid = constant('c_uuid');
  const limits = ['c_max_automations', 'c_max_triggers', 'c_max_devices'].map(constant);
  if (id && key) {
    compare('automationsVocabulary', `the id pattern in the schema and in automations_parse() (${parse.file})`,
      automation.properties.id.pattern, id[1]);
    compare('automationsVocabulary', 'the id pattern in the schema and in the table CHECK',
      automation.properties.id.pattern, key[1]);
  }
  if (forPattern && hold) {
    compare('automationsVocabulary', `the pattern of for in the schema and in automations_parse() (${parse.file})`,
      thresholdTrigger.properties.for.pattern, forPattern[1]);
    // Three digits of an hour at most, and the table holds that many seconds.
    const digits = Number(thresholdTrigger.properties.for.pattern.match(/\{0,(\d)\}/)?.[1]) + 1;
    compare('automationsVocabulary', 'the longest hold in hours the for pattern allows and the table CHECK holds',
      10 ** digits - 1, Number(hold[1]) / 3600);
  }
  if (uuid) {
    compare('automationsVocabulary', 'the device id pattern in the schema and in automations_parse()', deviceId.pattern, uuid[1]);
  }
  if (limits.every(Boolean)) {
    compare('automationsVocabulary', "the most automations in a file, triggers in an automation and devices in a trigger, in the schema and in automations_parse()",
      [schema.maxItems, automation.properties.triggers.maxItems, thresholdTrigger.properties.device.oneOf[1].maxItems].join(', '),
      limits.map((m) => m[1]).join(', '));
  }
  if (severity && platform) {
    compare('automationsVocabulary', 'the severities of the schema and the actions table',
      alertAction.properties.severity.enum.join(', '), words(severity[1]));
    compare('automationsVocabulary', 'the severities of the actions table and platform_alerts', words(severity[1]), words(platform[1]));
  }
  if (parse) {
    const listed = need(parse.body, /NOT \(v_val #>> '\{\}'\) = ANY \(ARRAY\[([^\]]*)\]\)/, `automations_parse()'s severities (${parse.file})`);
    if (listed) {
      compare('automationsVocabulary', `the severities automations_parse() admits (${parse.file}) and the schema`,
        words(listed[1]), alertAction.properties.severity.enum.join(', '));
    }
    compare('automationsVocabulary', `the trigger and action types automations_parse() admits (${parse.file}) and the schema`,
      [...parse.body.matchAll(/\(v_val #>> '\{\}'\) <> '([a-z]+)'/g)].map((m) => m[1]).join(', '),
      [thresholdTrigger.properties.trigger.const, alertAction.properties.action.const].join(', '));
    // The keys each level admits, in the order the function checks them: automation, trigger, action.
    const admitted = [...parse.body.matchAll(/NOT v_key = ANY \(ARRAY\[([^\]]*)\]\)/g)]
      .map((m) => [...m[1].matchAll(/'([a-z]+)'/g)].map((k) => k[1]).sort().join(', '));
    compare('automationsVocabulary', `the keys automations_parse() admits on an automation, a trigger and an action (${parse.file}) and the schema's properties`,
      admitted.join(' | '),
      [automation, thresholdTrigger, alertAction].map((d) => Object.keys(d.properties).sort().join(', ')).join(' | '));
  }
}
