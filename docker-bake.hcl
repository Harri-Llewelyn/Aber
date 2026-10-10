# The ingestion -> test-runner chain, for the release workflow.
#
# test-runner is `FROM` the ingestion image, so its base has to be resolvable at build time, and
# the base is the ingestion image built seconds earlier at the version being released, which no
# registry holds yet (nothing pushed on a dry run, a private package on a first release). Bake's
# `target:` context resolves that inside one build: test-runner's `FROM ${INGESTION_IMAGE}` names
# a context, not an image, and BuildKit hands it the ingestion target's result directly. That is
# what lets the chain build on the `docker-container` driver, which the SBOM and provenance
# attestations require and which `docker build` on the default driver cannot produce.
#
# The context is named `aber-ingestion`, deliberately not a registry reference: if the mapping ever
# failed to apply, a registry-shaped name would fall through to a pull (the 403 this file exists to
# avoid); an unqualified one fails loudly as `pull access denied`.
#
# The other ten images are independent and are built by docker/build-push-action in release.yml
# with the same labels and attestations; this file holds only the two that need each other.
#
#   VERSION=1.2.3 docker buildx bake ingestion-chain                 # build, no output
#   VERSION=1.2.3 docker buildx bake ingestion-chain --push          # publish both
#
# Variables come from the environment. The defaults serve a local build only.

variable "IMAGE_NAMESPACE" {
  default = "ghcr.io/harri-llewelyn/aber"
}

variable "VERSION" {
  default = "dev"
}

variable "SOURCE_URL" {
  default = "https://github.com/Harri-Llewelyn/Aber"
}

variable "REVISION" {
  default = ""
}

# The SLSA provenance's builder.id: the workflow run that built the image, when there is one.
# docker/build-push-action sets the same field for the other eight.
variable "BUILDER_ID" {
  default = ""
}

target "_release" {
  platforms = ["linux/amd64"]
  # `image.source` is what makes GHCR attach the package to the repository.
  labels = {
    "org.opencontainers.image.source"   = SOURCE_URL
    "org.opencontainers.image.revision" = REVISION
    "org.opencontainers.image.version"  = VERSION
    "org.opencontainers.image.licenses" = "MIT"
  }
  # An SPDX SBOM of the final filesystem (Syft, run by BuildKit) and SLSA provenance naming the
  # source, the Dockerfile, every build argument and every base image by digest. Both travel in
  # the image index as attestation manifests; SECURITY.md says how to read them.
  attest = [
    "type=sbom",
    "type=provenance,mode=max${BUILDER_ID != "" ? ",builder-id=${BUILDER_ID}" : ""}",
  ]
}

# Context is the REPOSITORY ROOT: ingestion/Dockerfile compiles sparkplug_b.proto with protoc and
# the .proto lives there.
target "ingestion" {
  inherits   = ["_release"]
  context    = "."
  dockerfile = "ingestion/Dockerfile"
  tags       = ["${IMAGE_NAMESPACE}/ingestion:${VERSION}"]
}

# Repository root again: test_aas_export.py resolves five files relative to parents[3].
target "test-runner" {
  inherits   = ["_release"]
  context    = "."
  dockerfile = "test-harness/Dockerfile"
  contexts = {
    "aber-ingestion" = "target:ingestion"
  }
  args = {
    INGESTION_IMAGE = "aber-ingestion"
  }
  tags = ["${IMAGE_NAMESPACE}/test-runner:${VERSION}"]
}

group "ingestion-chain" {
  targets = ["ingestion", "test-runner"]
}
