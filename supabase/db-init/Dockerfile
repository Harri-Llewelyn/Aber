# The Supabase schema chain, baked into the image that applies it.
#
# WHY THIS IMAGE EXISTS: TWO 1 MiB LIMITS, PULLING IN OPPOSITE DIRECTIONS.
#
# The migrations used to reach Kubernetes as a ConfigMap. A ConfigMap cannot exceed 1 MiB -- an etcd
# object limit, not a Kubernetes preference -- and the chain reached 878 KiB of which 57% is
# generated reference vocabulary. Gzipping each file fixed that: ~150 KiB, with room to grow.
#
# It broke the other limit. Helm stores a release as base64(gzip(json(release))) in a Secret, which
# has its own 1 MiB ceiling, and that release carries the migrations TWICE -- once as chart files,
# once base64-encoded into the rendered ConfigMap. Gzipped bytes are incompressible, so neither copy
# shrinks and base64 adds a third on top of each. Measured: 464 KB of a 1,213,920-byte release
# Secret, against a 1,048,576 limit. `helm install` then fails with
#
#     Secret "sh.helm.release.v1.acs-cymru.v1" is invalid: data: Too long
#
# naming the Secret and nothing about migrations. Un-gzipping is worse in both directions at once:
# 1,386,004 bytes in the release, and the ConfigMap alone back over its own limit at 1,255,337.
#
# THERE IS NO SIZE OF FILE THAT SATISFIES BOTH LIMITS AS THE CHAIN GROWS, because the same bytes are
# counted by both. So the migrations stop travelling through the release at all: they are baked here
# and read from the container filesystem, and the chart carries none of them. Deleting a bigger file
# would have bought one more vocabulary; this removes the coupling.
#
# THE BASE MATCHES THE DATABASE'S OWN IMAGE, and check-docs-drift.mjs asserts this FROM against
# `supabaseDb.image.tag` in values.yaml. psql's client version is what parses this SQL, and a
# client older than the server silently mis-handles syntax the migrations rely on -- so the two
# must not drift.
FROM supabase/postgres:17.6.1.160

# TOP LEVEL ONLY. `supabase/migrations/archive/` holds the superseded migrations, kept as reasoning
# and deliberately never executed -- a recursive copy would replay every one of them. The glob is
# what keeps them out, and it is the same rule sync-helm-chart-files.mjs applied when this was a
# mirror.
#
# COPIED FROM THE SOURCE DIRECTORY, so there is no second copy to fall out of step: the mirror this
# replaces needed a drift check precisely because it was a copy. What can still drift is the BASE
# above, which check-docs-drift.mjs holds against the chart's pin.
COPY migrations/*.sql /migrations/

# The Job supplies the command. Nothing is started here: this image is a filesystem plus psql, and
# the apply loop lives in the chart beside the connection details and the psql variables it passes.
