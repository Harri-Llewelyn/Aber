// One request to the broker's Dynamic Security plugin, through mosquitto_rr. The service runs it
// in its own container; the operator CLI and the orphan sweep run it inside the broker container
// through docker exec or kubectl exec. All three build the same command and the same stdin
// (controlArgv says why neither the password nor the payload is on argv), so they cannot disagree.
import { execFileSync } from 'node:child_process';

import { CredentialError } from './mosquitto-credentials.mjs';
import { controlArgv, controlInput, controlPayload, parseControlResponse } from './mosquitto-dynsec.mjs';

// connection: { host, port, username, password }. prefix: what runs the command, [] locally or a
// `docker exec -i <name>` / `kubectl exec -i <pod> -c mosquitto --` vector; without -i the command
// reads an empty stdin and fails. Returns a function that sends one command and returns its response.
export function controlSender(connection, prefix = []) {
  const [cmd, ...rest] = [...prefix, ...controlArgv(connection)];
  return (command) => {
    const input = controlInput(connection, controlPayload([command]));
    let out;
    try {
      out = execFileSync(cmd, rest, {
        encoding: 'utf8',
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
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
