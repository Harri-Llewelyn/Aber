import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 570. A device's schemas are picked from the list the metrics are picked from. MetricPicker and
// SchemaPicker both draw ListPicker and no control of a list's own beside it, the device form draws
// SchemaPicker, and frontend/README.md names the three. What the schema search reads is the same in
// the search box, which says it, and the Devices help.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems570 = [];
  const common = 'frontend/src/components/common';
  for (const name of ['MetricPicker', 'SchemaPicker']) {
    const src = read(`${common}/${name}.jsx`);
    if (!src.includes('<ListPicker')) problems570.push(`${common}/${name}.jsx does not draw ListPicker`);
    if (src.includes('<input')) problems570.push(`${common}/${name}.jsx draws an input of its own beside ListPicker's`);
  }

  const devices = read('frontend/src/components/tabs/DevicesTab.jsx');
  if (!devices.includes('<SchemaPicker')) problems570.push('the device form (DevicesTab.jsx) does not pick its schemas with SchemaPicker');
  if (read('frontend/src/App.css').includes('.schema-checklist')) problems570.push('App.css styles .schema-checklist, which nothing draws');

  const readme = read('frontend/README.md');
  for (const name of ['(`common/ListPicker.jsx`)', '**`MetricPicker`**', '**`SchemaPicker`**']) {
    if (!readme.includes(name)) problems570.push(`frontend/README.md does not name ${name} where it says how a long list is chosen from`);
  }

  if (!read(`${common}/SchemaPicker.jsx`).includes("'Search name, description or metric'")) {
    problems570.push(`${common}/SchemaPicker.jsx's search does not say it reads a name, a description or a metric`);
  }
  if (!read('help/pages/devices.md').includes('It finds a name, a word of a description, or a metric')) {
    problems570.push('help/pages/devices.md does not say the schema search finds a name, a word of a description, or a metric');
  }

  if (problems570.length) {
    for (const p of problems570) fail(`a device's schemas are picked from the shared list: ${p}`);
  } else {
    pass("a device's schemas and a schema's metrics are both picked from ListPicker, the README names the three, and the schema search reads the same in its box and in the Devices help");
  }
}
