/**
 * Every command the dashboard shows to run on a Remote gateway's appliance. The dialogs and the
 * drawer read them from here, and scripts/drift-checks/546 holds the help page's *Commands on the
 * appliance* and the appliance README to the same text. The install command itself is the server's.
 *
 * Two lines with `sudo` are joined with `&&`: pasted as two commands, sudo's password prompt would
 * take the second line for the password.
 */

/** The help page's section on these commands, as HelpLink takes it. */
export const APPLIANCE_COMMANDS_HELP = 'site/remote-gateways#commands-on-the-appliance'

/**
 * Clears the enrolment of an appliance the install command set up, or the platform playbook has run
 * on. The containers go first: removing the folders under running containers leaves Docker holding
 * the old one, and the next install stops when it starts them. `-p`, not a folder, so it works when
 * the folders are already gone.
 */
export const CLEAR_INSTALLED_ENROLMENT = [
  'sudo docker compose -p aber-gateway down -v &&',
  'sudo rm -rf /var/lib/aber-gateway/data /opt/aber-gateway',
].join('\n')

/** Clears a bundle's enrolment, run in the bundle's folder: its /data is a volume of that project. */
export const CLEAR_BUNDLE_ENROLMENT = 'docker compose down -v'

/** Why the last convergence ended as it did. */
export const CONVERGE_JOURNAL = 'sudo journalctl -u aber-gateway-converge -n 30 --no-pager'

/** What flow-sync last did: why nothing is reported, or why an approved flow was not deployed. */
export const FLOW_SYNC_LOG = 'sudo docker logs --tail 20 aber-gateway-flow-sync'

/** A new Node-RED editor password, printed once, and the restart that puts it into use. */
export const RESET_EDITOR_PASSWORD = [
  'sudo docker compose --project-directory /opt/aber-gateway run --rm bootstrap /bundle/bootstrap.mjs --reset-admin-password &&',
  'sudo docker compose --project-directory /opt/aber-gateway restart node-red',
].join('\n')

/** The same, run in a bundle's folder. */
export const RESET_BUNDLE_EDITOR_PASSWORD = [
  'docker compose run --rm bootstrap /bundle/bootstrap.mjs --reset-admin-password',
  'docker compose restart node-red',
].join('\n')

/** What starts a bundle, from where its folder was copied to. */
export const startBundle = (folder) => [
  `cd ${folder}`,
  'docker compose up -d --build',
  'docker compose logs bootstrap',
].join('\n')
