import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 391. A full queue drops at once while the historian is down, under the reason the alerts and the
// dashboards already read. TelemetryWriter.submit() puts without waiting while `_down`, and drops
// with "db_unavailable"; the writer that is stopped drops the same way; metrics.py maps that reason
// to messages_dropped_total, and the README names it where it says what a drop counts, in the loss
// table, in the reason list and beside the queue's configuration. A drop under a new reason would
// leave "Telemetry being dropped" and the System page's figures blind to it.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems391 = [];
  const daemon = read('ingestion/ingestion.py');
  const metrics = read('ingestion/metrics.py');
  const readme = read('ingestion/README.md');
  const reason = 'db_unavailable';
  const submit = daemon.match(/^ {4}def submit\(self, pending\):[\s\S]*?(?=\n {4}def )/m)?.[0] ?? '';
  if (!/if self\._down:\s+self\._queue\.put_nowait\(pending\)/.test(submit)) problems391.push('TelemetryWriter.submit() does not put without waiting while the historian is down');
  if (!/if self\._down:\s+drop\(\s+"db_unavailable"/.test(submit)) problems391.push(`TelemetryWriter.submit() does not drop a full queue with the reason ${reason} while the historian is down`);
  if (!/drop\(\s+"write_queue_full"/.test(submit)) problems391.push('TelemetryWriter.submit() no longer drops a full queue with the reason write_queue_full while the historian is up');
  if (!submit.includes('emit_log=not self._drop_logged')) problems391.push('TelemetryWriter.submit() logs every drop of an outage, not one');
  const write = daemon.match(/^ {4}def _write\(self, batch, retry=True\):[\s\S]*?(?=\n {4}def |\n_writer )/m)?.[0] ?? '';
  if (!/drop\(\s+"db_unavailable"/.test(write)) problems391.push(`TelemetryWriter._write() does not drop a batch it has no connection for with the reason ${reason}`);
  const series = metrics.match(new RegExp(`"dropped_${reason}": \\(\\s+"([a-z_]+)", \\{"reason": "${reason}"\\}\\)`))?.[1];
  if (!series) problems391.push(`ingestion/metrics.py does not map dropped_${reason} to the reason ${reason}`);

  const short = (series ?? 'aber_ingestion_messages_dropped_total').replace(/^aber_ingestion_/, '');
  const loss = readme.split('\n').find((l) => l.startsWith('| **4** |')) ?? '';
  if (!loss.includes(`\`${short}{reason="${reason}"}\``)) problems391.push(`ingestion/README.md's loss table has no fourth row that names \`${short}{reason="${reason}"}\``);
  const section = readme.match(/^### Connection handling\n[\s\S]*?(?=\n---\n)/m)?.[0].replace(/\s+/g, ' ') ?? '';
  if (!section) problems391.push('ingestion/README.md has no "Connection handling" section');
  for (const piece of ['**A full queue drops at once while the historian is down.**', `\`${short}{reason="${reason}"}\``, 'as `write_queue_full`']) {
    if (section && !section.includes(piece)) problems391.push(`ingestion/README.md's Connection handling does not say ${piece}`);
  }
  const reasons = readme.match(/^`reason` on the drop counter:[\s\S]*?(?=\n\n)/m)?.[0].replace(/\s+/g, ' ') ?? '';
  if (!reasons.includes(`\`${reason}\` (the historian was down and the queue full`)) problems391.push(`ingestion/README.md's list of drop reasons does not say when ${reason} is counted`);
  const config = readme.split('\n').find((l) => l.startsWith('| `TELEMETRY_QUEUE_MAX_MESSAGES` |')) ?? '';
  if (!config.includes('at once while the historian is down')) problems391.push('ingestion/README.md\'s Configuration table does not say a full queue drops at once while the historian is down');
  if (!read('test-harness/README.md').includes(`drops at once, as \`reason="${reason}"\``)) problems391.push(`test-harness/README.md's ceilings table does not say a full queue drops at once as ${reason} while the historian is down`);

  if (problems391.length) {
    for (const p of problems391) fail(`the full queue's drop while the historian is down: ${p}`);
  } else {
    pass(`a full queue drops at once as ${reason} while the historian is down, counted by ${series}, and the README's loss table, Connection handling and reasons say so`);
  }
}
