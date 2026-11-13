import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 356. A message held alone is written once more when the connection was the fault. ingestion.py
// tells a lost connection (an InterfaceError, or an OperationalError after which the connection
// reports itself closed) from a bad message, retries once on a fresh connection and counts the save;
// metrics.py maps and helps that counter, and the README's Connection handling and metrics table say
// the same. A README that promised the retry of a code that dropped the message would send an
// operator to the wrong counter.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems356 = [];
  const daemon = read('ingestion/ingestion.py');
  const metrics = read('ingestion/metrics.py');
  const readme = read('ingestion/README.md');
  const flat = 'write_retries_saved';
  const series = metrics.match(new RegExp(`"${flat}": \\("([a-z_]+)", \\{\\}\\)`))?.[1];
  if (!series) problems356.push(`could not read the series of ${flat} out of ingestion/metrics.py`);
  else {
    if (!metrics.includes(`"${series}":\n`)) problems356.push(`ingestion/metrics.py gives ${series} no help text`);
    if (!readme.includes(`| \`${series}\` |`)) problems356.push(`ingestion/README.md's metrics table has no row for \`${series}\``);
  }
  const lost = daemon.match(/^def _connection_lost\(exc, conn\):[\s\S]*?(?=\n\S)/m)?.[0] ?? '';
  if (!lost.includes('isinstance(exc, psycopg2.InterfaceError)')) problems356.push('_connection_lost() does not treat an InterfaceError as the connection');
  if (!/isinstance\(exc, psycopg2\.OperationalError\) and conn\.closed != 0/.test(lost)) problems356.push('_connection_lost() does not limit an OperationalError to a connection that reports itself closed');
  const write = daemon.match(/^ {4}def _write\(self, batch, retry=True\):[\s\S]*?(?=\n\S|\n {4}def |\n_writer )/m)?.[0] ?? '';
  if (!write.includes('self._write(batch, retry=False)')) problems356.push('TelemetryWriter._write() does not retry a lone message exactly once');
  if (!write.includes(`count("${flat}")`)) problems356.push(`TelemetryWriter._write() never counts ${flat}`);
  const section = readme.match(/^### Connection handling\n[\s\S]*?(?=\n---\n)/m)?.[0].replace(/\s+/g, ' ') ?? '';
  if (!section) problems356.push('ingestion/README.md has no "Connection handling" section');
  for (const piece of ['`psycopg2.InterfaceError`', 'an `OperationalError` after which the connection reports itself closed',
    '`get_timescaledb_connection()` once', 'once more', series && `\`${series.replace(/^aber_ingestion_/, '')}\``, '`write_failures_total`',
    '`messages_dropped_total{reason="db_unavailable"}`', '`ON CONFLICT DO NOTHING`'].filter(Boolean)) {
    if (section && !section.includes(piece)) problems356.push(`ingestion/README.md's Connection handling does not say ${piece}`);
  }
  if (problems356.length) {
    fail('the writer retry and its documents disagree:\n' + problems356.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`a lone message that fails on a lost connection is written once more on a fresh one, counted by ${series}, and the Connection handling section and the metrics table say so`);
  }
}
