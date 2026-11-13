import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 8c. The Trivy that CI installs is the release scan:config and scan:images run locally, so a
// finding reproduces on a laptop. Renovate bumps the local image; the CI pin and its checksum are
// refreshed by hand.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const action = read('.github/actions/install-trivy/action.yml');
  const local = read('scripts/scan-config.mjs');
  const ci = action.match(/TRIVY_VERSION:\s*([0-9.]+)/)?.[1];
  const pinned = local.match(/aquasec\/trivy:([0-9.]+)@/)?.[1];
  const configImage = local.match(/aquasec\/trivy:[^'\s]+/)?.[0];
  const imagesImage = read('scripts/scan-images.mjs').match(/aquasec\/trivy:[^'\s]+/)?.[0];
  if (!ci || !pinned || !imagesImage) {
    fail('check 8c cannot find the Trivy version in install-trivy/action.yml, scan-config.mjs or scan-images.mjs');
  } else if (imagesImage !== configImage) {
    fail(`scan:config runs ${configImage} and scan:images runs ${imagesImage}; pin both to the same image`);
  } else if (ci !== pinned) {
    fail(
      `CI installs Trivy ${ci} and scan:config runs ${pinned}. Move install-trivy to ${pinned} ` +
      'and replace TRIVY_SHA256 from that release\'s checksums file.'
    );
  } else {
    pass(`CI, scan:config and scan:images run the same Trivy release (${ci})`);
  }
}
