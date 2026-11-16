import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 384. The help names the four places a device can be, as the picker offers them. LocationPicker's
// choices for a device are Follow Gateway, In a cell, Area-Wide and Site-Wide, in that order; the
// Devices help says what each is, what Follow Gateway does, and the sentence the form shows under it;
// the Site Map help says where a device that follows its gateway is placed; the Gateways help does
// not say that every device takes its gateway's location. The sentence's shapes are the ones
// followedPlaceLine() builds.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const picker = read('frontend/src/components/common/LocationPicker.jsx');
  const resolution = read('frontend/src/utils/cellResolution.js');
  const devices = read('help/pages/devices.md');
  const siteMap = read('help/pages/site-map.md');
  const gateways = read('help/pages/gateways.md');
  const problems384 = [];

  const labels = [...picker.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  const offered = ['Follow Gateway', 'In a cell', 'Area-Wide', 'Site-Wide'];
  if (labels.join(',') !== offered.join(',')) {
    problems384.push(`LocationPicker.jsx offers ${labels.join(', ')}, not ${offered.join(', ')} in that order`);
  }
  for (const label of offered) {
    if (!devices.includes(`**${label}**`)) problems384.push(`help/pages/devices.md does not name **${label}**, which the Location picker offers`);
  }
  if (!/A location is one of four: \*\*Follow Gateway\*\*, \*\*In a cell\*\*, \*\*Area-Wide\*\*/.test(devices)) {
    problems384.push('help/pages/devices.md does not say a location is one of four, in the picker\'s order');
  }

  // What Follow Gateway does, and the line the form shows under it.
  const follow = devices.split('\n').find((l) => l.startsWith('- **Follow Gateway** is the first choice'));
  if (!follow) {
    problems384.push('help/pages/devices.md has no paragraph starting "**Follow Gateway** is the first choice"');
  } else {
    for (const phrase of ['a new device has it', 'moves with it', '**Unassigned**', 'keeps its own place', 'Save stays off']) {
      if (!follow.includes(phrase)) problems384.push(`the Follow Gateway paragraph of help/pages/devices.md does not say "${phrase}"`);
    }
    const example = follow.match(/such as "([^"]+)"/)?.[1] || '';
    if (!/^Area-Wide in [A-Z][A-Za-z]*, from [A-Z][A-Za-z]*$/.test(example)) {
      problems384.push(`the example line in help/pages/devices.md, "${example}", is not of the form "Area-Wide in <area>, from <gateway>"`);
    }
  }
  for (const shape of ['`Area-Wide in ${areaName(gateway.area_id)}, from ${from}`', '`Site-Wide, from ${from}`',
    '`Unassigned: ${from} has no location`', "'Unassigned: it has no gateway'"]) {
    if (!resolution.includes(shape)) problems384.push(`cellResolution.js's followedPlaceLine() no longer builds ${shape}`);
  }

  if (!/\*\*A device set to Follow Gateway\*\* is placed where its gateway is/.test(siteMap)) {
    problems384.push('help/pages/site-map.md does not say where a device set to Follow Gateway is placed');
  }
  if (!gateways.includes('when they are set to **Follow Gateway**')) {
    problems384.push('help/pages/gateways.md does not say the devices that take a gateway\'s location are the ones set to Follow Gateway');
  }
  if (/and the devices reporting through it take that location\./.test(gateways)) {
    problems384.push('help/pages/gateways.md says every device reporting through a gateway takes its location');
  }

  if (problems384.length) {
    fail('the help describes a device\'s location otherwise than the picker offers it:\n' +
      problems384.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the Devices, Site Map and Gateways help name Follow Gateway, In a cell, Area-Wide and Site-Wide as the picker offers them, and the line the form shows under Follow Gateway');
  }
}
