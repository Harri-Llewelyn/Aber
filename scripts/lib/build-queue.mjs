/**
 * The order of `dev-cluster up`'s image builds: at most `jobs` at once, each in list order once the
 * image it is `after` has built, and after a failure nothing new starts while the running ones
 * finish. The build itself is passed in, so the tests run the queue without docker. node:
 * built-ins only.
 */

/** How many images build at once when ABER_BUILD_JOBS is unset. */
export const DEFAULT_BUILD_JOBS = 4;

/** ABER_BUILD_JOBS as a cap: unset or empty is the default, and anything but a positive integer throws. */
export function buildJobs(value) {
  const text = (value ?? '').trim();
  if (text === '') return DEFAULT_BUILD_JOBS;
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error(`ABER_BUILD_JOBS must be a positive integer, how many images build at once (1 builds them one after another), not ${JSON.stringify(value)}`);
  }
  return Number(text);
}

/**
 * Runs `start(task)` for each of `tasks` ({ name, after? }) and resolves once nothing is running.
 * An `after` that names no task in the list counts as built already: `--only=test-runner` builds on
 * the ingestion image the host holds. `start` resolves to `{ ok, ... }`; a throw or rejection is a
 * failure. Resolves to the results by name, the names that failed, and the names never started.
 * Throws when tasks wait on each other in a cycle.
 */
export async function runQueue(tasks, jobs, start) {
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`jobs must be a positive integer, not ${jobs}`);
  const listed = new Set(tasks.map((t) => t.name));
  const built = new Set();
  const results = new Map();
  const pending = [...tasks];
  const running = new Map();
  let failed = false;
  const ready = (t) => !t.after || !listed.has(t.after) || built.has(t.after);
  for (;;) {
    while (!failed && running.size < jobs) {
      const next = pending.findIndex(ready);
      if (next < 0) break;
      const [task] = pending.splice(next, 1);
      running.set(task.name, Promise.resolve()
        .then(() => start(task))
        .catch((error) => ({ ok: false, error }))
        .then((result) => ({ task, result })));
    }
    if (!running.size) break;
    const { task, result } = await Promise.race(running.values());
    running.delete(task.name);
    results.set(task.name, result);
    if (result?.ok) built.add(task.name);
    else failed = true;
  }
  if (!failed && pending.length) {
    throw new Error(`these wait for each other and never start: ${pending.map((t) => `${t.name} (after ${t.after})`).join(', ')}`);
  }
  return {
    results,
    failed: [...results].filter(([, r]) => !r?.ok).map(([name]) => name),
    notStarted: pending.map((t) => t.name),
  };
}
