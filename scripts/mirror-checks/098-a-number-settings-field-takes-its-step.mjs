import { compare, need, ok, read, SCHEMA } from './lib.mjs';

// 98. A number setting's field takes its step from the flag 0285 adds. SettingsTab.jsx gives a number
// field a step of 1 where whole_number is true and any step otherwise, the settings read selects the
// column, and coerceValue() refuses a part value on the same property. A field that offers a step the
// flag does not hold, or a read that leaves the column out, shows every setting as a fraction.
export default function check() {
  const column = need(SCHEMA, /ADD COLUMN IF NOT EXISTS (whole_number) boolean DEFAULT false NOT NULL/,
    'the whole_number column on system_settings in 0285');
  const tab = read('frontend/src/components/tabs/SettingsTab.jsx');
  const step = need(tab, /step: setting\.(\w+) \? (\d+) : '(\w+)'/, "the number field's step in SettingsTab.jsx");
  const coerce = need(tab, /whole_number: (\w+) \} = bounds\s+if \(\1 && !Number\.isInteger\(n\)\)/,
    "coerceValue()'s refusal of a part number in SettingsTab.jsx");
  const select = need(read('frontend/src/api.js'),
    /\.from\('system_settings'\)\s*\.select\('id,key,value,value_type,category,label,description,fallback_source,([^']*)'\)/,
    "the settings read's column list in api.js");
  if (column && step) {
    compare('settingStep', 'the flag the Settings field reads and 0285 adds', step[1], column[1]);
    compare('settingStep', "the step a whole setting's field offers and the step of whole numbers", step[2], '1');
    compare('settingStep', "the step any other number's field offers and the browser's no-step", step[3], 'any');
  }
  if (column && select) {
    compare('settingStep', 'whether the settings read selects the flag, in api.js', select[1].split(',').includes(column[1]), true);
  }
  if (column && coerce) ok.push(`settingStep: coerceValue() refuses a part number on bounds.${column[1]}, the field the read returns`);
}
