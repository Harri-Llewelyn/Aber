// =================================================================================================
// Fold freshly-issued gateway credentials into `.env`.
//
// WHY THIS IS THE RISKY PART OF A RESET, AND THEREFORE WHY IT IS EXTRACTED AND TESTED.
//
// `docker compose down -v` destroys the Mosquitto password volume, so provisioning issues NEW
// credentials while `.env` still holds the previous set. Compose passes `.env` to `node-red-init`,
// which then seeds Node-RED with passwords the broker no longer knows. Nothing fails during the
// reset: it reports success, and four gateways log
//
//     Connection failed to broker: node-red-cnc@mqtt://mosquitto:1883
//
// with NO CONNACK CODE, which `0040`'s header already documents as the confusing one. So a bug here
// does not surface as a bug here -- it surfaces minutes later as a broker problem, which is the
// signature of a defect worth a unit test rather than a careful read.
//
// REPLACED IN PLACE, APPENDED ONLY WHEN NEW. A duplicate assignment is read differently by docker
// compose and by a shell that sources the file, so appending unconditionally would leave the two
// disagreeing about which credential is live -- the class of bug that makes a rotation look applied
// when it is not.
//
// This was an awk one-liner in `stack-reset.sh` and is a string transform here; it is the same
// algorithm, and having it in a function is what lets the cases below be asserted rather than
// reasoned about.
// =================================================================================================

/**
 * The keys this owns. Deliberately narrow: it must rewrite gateway credentials and NOTHING else,
 * because it is handed a file holding the database passwords, the JWT secret and the service keys.
 * A wider pattern here would silently take whatever a future `.env.gateways` happened to contain.
 */
const GATEWAY_KEY = /^(MQTT_GW_[A-Z0-9_]+)=/;

/**
 * @param {string} envText          current `.env` contents
 * @param {string} gatewayEnvText   `.env.gateways` as provisioning just wrote it
 * @returns {{text: string, replaced: string[], added: string[]}}
 */
export function foldGatewayCredentials(envText, gatewayEnvText) {
  const fresh = new Map();
  for (const line of String(gatewayEnvText ?? '').split(/\r?\n/)) {
    const match = line.match(GATEWAY_KEY);
    // LAST ONE WINS, matching awk's `new[kv[1]] = $0`. A file with the same key twice is malformed,
    // and taking the later value is what a shell sourcing it would do.
    if (match) fresh.set(match[1], line);
  }

  const replaced = [];
  const seen = new Set();
  const out = String(envText ?? '').split(/\r?\n/).map((line) => {
    const match = line.match(GATEWAY_KEY);
    if (match && fresh.has(match[1])) {
      // EVERY occurrence is rewritten, not just the first. A `.env` that somehow holds a key twice
      // must not come out of this holding one new value and one stale one -- that is strictly worse
      // than either, because which one wins then depends on who reads the file.
      if (!seen.has(match[1])) replaced.push(match[1]);
      seen.add(match[1]);
      return fresh.get(match[1]);
    }
    return line;
  });

  const added = [];
  for (const [key, line] of fresh) {
    if (seen.has(key)) continue;
    // APPENDED AT THE END, where a shell and docker compose both read it last. Inserting near a
    // related key would read better and would mean choosing a place, which is a decision this has
    // no basis for making.
    out.push(line);
    added.push(key);
  }

  return { text: out.join('\n'), replaced, added };
}
