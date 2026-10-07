/**
 * What the two k3d clusters on a laptop share: the dev loop's (scripts/dev-cluster.mjs) and the
 * trial's (scripts/try.mjs). The process calls are passed in, so the tests stub them. node:
 * built-ins only.
 */
import { spawnSync } from 'node:child_process';

/** Host ports a cluster's load balancer publishes: Traefik, and the broker's two listeners. */
export const CLUSTER_PORTS = [80, 1883, 8883];

/** The Jobs a fresh install runs before anything can start, waited for in this order. */
export const INIT_JOBS = ['db-roles-init', 'db-init', 'storage-init'];

/** Where to get each tool. */
export const TOOLS = {
  docker: 'https://docs.docker.com/get-started/get-docker/',
  k3d: 'https://k3d.io/#installation',
  kubectl: 'https://kubernetes.io/docs/tasks/tools/',
  helm: 'https://helm.sh/docs/intro/install/',
};

/** True when `cmd args` runs and exits 0. */
function answers(spawn, cmd, args) {
  const r = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
  return !r.error && r.status === 0;
}

/**
 * Each of `tools` that cannot be used, as `{ tool, problem }`; empty when all can. Docker is
 * checked for a daemon that answers as well as a client on PATH, because every later step needs it.
 */
export function missingTools(tools, spawn = spawnSync) {
  const missing = [];
  for (const tool of tools) {
    const args = tool === 'kubectl' ? ['version', '--client'] : ['version'];
    if (!answers(spawn, tool, args) && !answers(spawn, tool, ['--version'])) {
      missing.push({ tool, problem: 'not installed' });
    } else if (tool === 'docker' && !answers(spawn, 'docker', ['info'])) {
      missing.push({ tool, problem: 'not running' });
    }
  }
  return missing;
}

/** One line per missing tool, saying where to get it or how to start it. */
export function describeMissing(missing) {
  return missing.map(({ tool, problem }) => (problem === 'not running'
    ? `  ${tool.padEnd(8)}installed, but not running. Start Docker Desktop, or \`sudo systemctl start docker\` on Linux.`
    : `  ${tool.padEnd(8)}not installed. Get it from ${TOOLS[tool]}`)).join('\n');
}

/** `k3d cluster create` arguments: one server, no agents, CLUSTER_PORTS on the host. */
export function createClusterArgs(name, extra = []) {
  return ['cluster', 'create', name, '--agents', '0',
    ...CLUSTER_PORTS.flatMap((p) => ['--port', `${p}:${p}@loadbalancer`]),
    '--k3s-arg', '--disable=metrics-server@server:0', ...extra, '--wait'];
}

/** The clusters `k3d cluster list -o json` printed, as `{ name, running }`. */
export function parseClusters(json) {
  return JSON.parse(json || '[]').map((c) => ({
    name: c.name,
    running: (c.serversRunning ?? 0) > 0,
  }));
}

/** The host port of the API server, from `docker port k3d-<name>-serverlb 6443`. */
export function apiPort(dockerPortOutput) {
  return /:(\d+)\s*$/m.exec(dockerPortOutput || '')?.[1] ?? null;
}

/**
 * The containers that publish `port` on the host, from
 * `docker ps --format "{{.Names}}\t{{.Ports}}"`. Ranges such as `0.0.0.0:8000-8002->...` count.
 */
export function publishersOf(psOutput, port) {
  const names = [];
  for (const line of (psOutput || '').split('\n')) {
    const [name, ports = ''] = line.split('\t');
    for (const m of ports.matchAll(/:(\d+)(?:-(\d+))?->/g)) {
      const low = Number(m[1]);
      const high = Number(m[2] ?? m[1]);
      if (port >= low && port <= high && !names.includes(name.trim())) names.push(name.trim());
    }
  }
  return names;
}

/** What to tell someone whose port is taken, naming the k3d cluster when one holds it. */
export function portTakenMessage(port, holders, devCluster = 'aber') {
  const cluster = holders.map((h) => /^k3d-(.+)-serverlb$/.exec(h)?.[1]).find(Boolean);
  if (cluster === devCluster) {
    return `port ${port} is held by the dev cluster \`${devCluster}\`. Stop it first:\n` +
      `  k3d cluster stop ${devCluster}\n(\`k3d cluster start ${devCluster}\` brings it back, with its data.)`;
  }
  if (cluster) {
    return `port ${port} is held by the k3d cluster \`${cluster}\`. Stop it first:\n  k3d cluster stop ${cluster}`;
  }
  if (holders.length) return `port ${port} is held by the container ${holders.join(', ')}. Stop it first.`;
  return `port ${port} is in use by another program on this machine. Stop it first.`;
}
