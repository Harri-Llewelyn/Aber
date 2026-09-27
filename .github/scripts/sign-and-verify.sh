#!/usr/bin/env bash
# Sign each published artefact and then run, from inside the release, exactly the verification a
# consumer runs from outside it.
#
# Usage:  sign-and-verify.sh <registry/repo@sha256:...> [...]
#
# Every reference must carry its digest: a tag can be moved between the push and the signature,
# and `cosign sign` refuses one anyway. For each reference this
#   1. signs it -- keyless by default, so the signature is bound to this workflow's OIDC identity
#      and there is no key to hold or leak;
#   2. verifies the signature against that identity, which is the README's one-liner and proves
#      the one-liner is true for this release rather than assumed;
#   3. unless CHECK_ATTESTATIONS=false (the chart carries none), reads the SBOM and the provenance
#      back out of the registry and refuses an image missing either. Attestations are a build
#      option that fails silently when the driver cannot produce them, so a release that pushed
#      images nothing attested must not be able to report green.
#
# Environment:
#   EXPECTED_IDENTITY   the certificate identity to verify against; under Actions,
#                       <server>/<owner>/<repo>/.github/workflows/release.yml@<ref>
#   OIDC_ISSUER         default https://token.actions.githubusercontent.com
#   CHECK_ATTESTATIONS  default true
#   COSIGN_SIGN_ARGS / COSIGN_VERIFY_ARGS
#                       replace the keyless flags, for a rehearsal outside Actions with a key pair
#                       (`--key cosign.key` / `--key cosign.pub`). Keyless needs an OIDC token that
#                       only a workflow run holds.
#
# Needs cosign 3 (the bundle format and OCI 1.1 referrers are its defaults), docker buildx and jq.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <ref@sha256:...> [...]" >&2
  exit 2
fi

OIDC_ISSUER="${OIDC_ISSUER:-https://token.actions.githubusercontent.com}"
CHECK_ATTESTATIONS="${CHECK_ATTESTATIONS:-true}"

# Keyless unless both overrides are given. Word-splitting the overrides is the point: they carry
# flags.
if [ -n "${COSIGN_SIGN_ARGS+x}" ] && [ -n "${COSIGN_VERIFY_ARGS+x}" ]; then
  # shellcheck disable=SC2206
  SIGN_ARGS=(${COSIGN_SIGN_ARGS})
  # shellcheck disable=SC2206
  VERIFY_ARGS=(${COSIGN_VERIFY_ARGS})
else
  if [ -z "${EXPECTED_IDENTITY:-}" ]; then
    echo "::error::EXPECTED_IDENTITY is not set (and COSIGN_SIGN_ARGS/COSIGN_VERIFY_ARGS do not replace it)" >&2
    exit 2
  fi
  SIGN_ARGS=()
  VERIFY_ARGS=(--certificate-identity "$EXPECTED_IDENTITY" --certificate-oidc-issuer "$OIDC_ISSUER")
fi

SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
{
  echo "| Artefact | Signature | SBOM | Provenance |"
  echo "| :--- | :--- | :--- | :--- |"
} >> "$SUMMARY"

for REF in "$@"; do
  case "$REF" in
    *@sha256:*) ;;
    *)
      echo "::error::$REF carries no digest; refusing to sign a tag" >&2
      exit 1
      ;;
  esac

  echo "::group::$REF"
  cosign sign --yes "${SIGN_ARGS[@]}" "$REF"

  # Output is the verified bundle as JSON, which is noise here; the exit code is the result.
  cosign verify "${VERIFY_ARGS[@]}" "$REF" > /dev/null
  echo "  ok  signature verifies"

  SBOM='n/a'
  PROV='n/a'
  if [ "$CHECK_ATTESTATIONS" = 'true' ]; then
    # .SBOM.SPDX is the final image's document; .SBOM.AdditionalSPDXs holds any build stage the
    # Dockerfile opted in (the frontend's node_modules). The package count is the main document's.
    read -r PKGS STAGES < <(docker buildx imagetools inspect "$REF" --format '{{json .SBOM}}' \
      | jq -r '[((.SPDX.packages // []) | length), ((.AdditionalSPDXs // []) | length)] | @tsv')
    if [ "${PKGS:-0}" -eq 0 ]; then
      echo "::error::$REF carries no SBOM attestation" >&2
      exit 1
    fi
    echo "  ok  SBOM: $PKGS packages in the image, $STAGES build stage(s) also scanned"

    # mode=max provenance lists every base image and source by digest. BuildKit writes the SLSA
    # v1 predicate (buildDefinition/runDetails) from 0.32; older builders write v0.2, with
    # buildType and materials at the top. Both are accepted, and the consumer reads either the
    # same way (`{{json .Provenance.SLSA}}`).
    read -r BUILD_TYPE MATERIALS < <(docker buildx imagetools inspect "$REF" --format '{{json .Provenance}}' \
      | jq -r '[(.SLSA.buildDefinition.buildType // .SLSA.buildType // ""),
                ((.SLSA.buildDefinition.resolvedDependencies // .SLSA.materials // []) | length)] | @tsv')
    if [ -z "$BUILD_TYPE" ]; then
      echo "::error::$REF carries no provenance attestation" >&2
      exit 1
    fi
    echo "  ok  provenance: $BUILD_TYPE, $MATERIALS material(s)"
    SBOM="$PKGS packages"
    PROV="$MATERIALS materials"
  fi
  echo "::endgroup::"
  echo "| \`$REF\` | verified | $SBOM | $PROV |" >> "$SUMMARY"
done
