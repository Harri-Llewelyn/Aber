import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 390. The writer waits for a historian that is down, and the README says how. ingestion.py starts
// at DB_OUTAGE_RETRY_START_SECONDS, doubles and stops at DB_OUTAGE_RETRY_MAX_SECONDS; the
// Configuration table and Connection handling carry those defaults and the waits they give. The
// queue holds TELEMETRY_QUEUE_MAX_MESSAGES messages, so each figure in the README's table of how
// long it holds is that size over the rate beside it. A README that promised 0.5 s doubling to 5 s
// of a code that waited 2 s would misread every outage, and a figure that kept the old queue size
// would give #1494 a threshold the queue cannot meet.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems390 = [];
  const daemon = read('ingestion/ingestion.py');
  const readme = read('ingestion/README.md');
  const config = (name) => daemon.match(new RegExp(`^${name} = (?:int|float)\\(os\\.getenv\\("${name}", "([0-9.]+)"\\)\\)`, 'm'))?.[1];
  const start = Number(config('DB_OUTAGE_RETRY_START_SECONDS'));
  const max = Number(config('DB_OUTAGE_RETRY_MAX_SECONDS'));
  const queue = Number(config('TELEMETRY_QUEUE_MAX_MESSAGES'));
  if (!start || !max || !queue) {
    fail('the writer waits: could not read DB_OUTAGE_RETRY_START_SECONDS, DB_OUTAGE_RETRY_MAX_SECONDS and TELEMETRY_QUEUE_MAX_MESSAGES defaults out of ingestion/ingestion.py');
    return;
  }
  const connection = daemon.match(/^ {4}def _connection\(self, in_hand\):[\s\S]*?(?=\n {4}def )/m)?.[0] ?? '';
  if (!connection.includes('delay = DB_OUTAGE_RETRY_START_SECONDS')) problems390.push('TelemetryWriter._connection() does not start at DB_OUTAGE_RETRY_START_SECONDS');
  if (!connection.includes('delay = min(delay * 2, DB_OUTAGE_RETRY_MAX_SECONDS)')) problems390.push('TelemetryWriter._connection() does not double up to DB_OUTAGE_RETRY_MAX_SECONDS');
  if (!connection.includes('self._stop.wait(delay)')) problems390.push('TelemetryWriter._connection() does not wait on the stop event, so a shutdown would sit behind the wait');

  const waits = [];
  for (let delay = start; ; delay = Math.min(delay * 2, max)) {
    waits.push(delay);
    if (delay >= max) break;
  }
  const rows = (name) => readme.split('\n').filter((l) => l.startsWith(`| \`${name}\` |`));
  for (const [name, value] of [['DB_OUTAGE_RETRY_START_SECONDS', start], ['DB_OUTAGE_RETRY_MAX_SECONDS', max]]) {
    const row = rows(name);
    if (row.length !== 1) problems390.push(`ingestion/README.md's Configuration table has ${row.length} rows for ${name}, not one`);
    else if (!row[0].startsWith(`| \`${name}\` | \`${value}\` |`)) problems390.push(`ingestion/README.md's Configuration table does not give ${name} the default ${value}`);
  }
  const section = readme.match(/^### Connection handling\n[\s\S]*?(?=\n---\n)/m)?.[0].replace(/\s+/g, ' ') ?? '';
  if (!section) problems390.push('ingestion/README.md has no "Connection handling" section');
  const sequence = `${waits.slice(0, -1).join(', ')}, then ${waits.at(-1)} s`;
  for (const piece of [`\`DB_OUTAGE_RETRY_START_SECONDS\` (${start} s)`, `\`DB_OUTAGE_RETRY_MAX_SECONDS\` (${max} s)`, sequence,
    `\`TELEMETRY_QUEUE_MAX_MESSAGES\` (${queue.toLocaleString('en-US')})`]) {
    if (section && !section.includes(piece)) problems390.push(`ingestion/README.md's Connection handling does not say ${piece}`);
  }

  // The table of how long the queue holds: one rate and one length of time in each row.
  const held = section.match(/\| Messages arriving \| The queue holds \|(?: \| :--- \| :--- \|)?((?: \| [^|]+ \| [^|]+ \|)+)/)?.[1] ?? '';
  const figures = [...held.matchAll(/\| ([0-9.,]+) msg\/s[^|]*\| ([0-9,]+) s\b[^|]*\|/g)].map((m) => [Number(m[1].replace(/,/g, '')), Number(m[2].replace(/,/g, ''))]);
  if (figures.length < 3) problems390.push('ingestion/README.md has no table of how long the queue holds, in the shape this check reads');
  for (const [rate, seconds] of figures) {
    const exact = queue / rate;
    if (Math.abs(seconds - exact) > exact * 0.01) problems390.push(`ingestion/README.md says the queue holds ${seconds} s at ${rate} msg/s; ${queue.toLocaleString('en-US')} over ${rate} is ${Math.round(exact)} s`);
  }
  const [, restartText, upToText] = section.match(/A historian restart takes about ([0-9]+) s\. The queue holds one at any rate up to ([0-9]+) msg\/s/) ?? [];
  const restart = Number(restartText);
  const upTo = Number(upToText);
  if (!restart || !upTo) problems390.push('ingestion/README.md does not say how fast a restart can be held');
  else if (upTo > queue / restart || upTo < (queue / restart) * 0.95) problems390.push(`ingestion/README.md says a ${restart} s restart is held up to ${upTo} msg/s; ${queue.toLocaleString('en-US')} over ${restart} is ${Math.floor(queue / restart)}`);
  const hundred = queue / 100;
  if (!readme.includes(`${hundred} s into an outage at 100 msg/s`)) problems390.push(`ingestion/README.md's loss table does not say the queue is full ${hundred} s into an outage at 100 msg/s`);

  if (problems390.length) {
    for (const p of problems390) fail(`the writer's wait for the historian: ${p}`);
  } else {
    pass(`the writer waits ${waits.join(', ')} s for a historian that is down, and the queue's ${queue.toLocaleString('en-US')} messages hold ${hundred} s at 100 msg/s, as the Configuration table and Connection handling say`);
  }
}
