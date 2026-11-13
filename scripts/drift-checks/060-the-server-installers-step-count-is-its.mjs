import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 60. The server installer's step count is its number of steps. Each step prints `[n/STEPS]`, and
// a step added without raising STEPS ends the install on `[9/8]`, as 1.3.0's did.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const INSTALLER = 'deploy/install.sh';
  const script = read(INSTALLER);
  const declared = Number(script.match(/^STEPS=(\d+)\s*$/m)?.[1]);
  const steps = [...script.matchAll(/^\s+step "/gm)].length;
  if (!declared) {
    fail(`${INSTALLER} no longer sets STEPS= on a line of its own; the extraction no longer matches`);
  } else if (declared !== steps) {
    fail(`${INSTALLER} sets STEPS=${declared} and calls step ${steps} times. Change STEPS to ${steps}`);
  } else {
    pass(`the server installer counts ${steps} steps and calls step ${steps} times`);
  }
}
