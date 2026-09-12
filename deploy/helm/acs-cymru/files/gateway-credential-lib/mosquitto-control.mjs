/**
 * One request to the broker's Dynamic Security plugin, through `mosquitto_rr`.
 *
 * The service runs the binary locally; the operator CLI and the orphan sweep run it inside the
 * broker container through `docker exec` or `kubectl exec`. All three build the same argument
 * vector (controlArgv says why the payload is on it), so the three cannot disagree about the
 * protocol.
 */
import { execFileSync } from 'node:child_process';

import { CredentialError } from './mosquitto-credentials.mjs';
import { controlArgv, controlPayload, parseControlResponse } from './mosquitto-dynsec.mjs';

/**
 * @param {object} connection  { host, port, username, password }
 * @param {string[]} [prefix]  what runs the binary: [] locally, or a `docker exec <name>` /
 *                             `kubectl exec <pod> -c mosquitto --` vector.
 * @returns {(command: object) => object}  sends one command and returns its response
 */
export function controlSender(connection, prefix = []) {
  return (command) => {
    const [cmd, ...rest] = [...prefix, 'mosquitto_rr', ...controlArgv(connection, controlPayload([command]))];
    let out;
    try {
      out = execFileSync(cmd, rest, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20000,
      });
    } catch (err) {
      const detail = (err.stderr || err.message || '').toString().trim().split('\n')[0];
      throw new CredentialError(`the broker did not answer ${command.command}: ${detail}`, 'backend_unavailable');
    }
    const [response] = parseControlResponse(out);
    return response || {};
  };
}
