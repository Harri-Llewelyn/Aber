# Edge functions, baked into an image rather than bind-mounted.
#
# WHY. Mounting ./supabase/functions into the stock supabase/edge-runtime image is the obvious
# arrangement -- editing a function and restarting one container is the whole development loop --
# and it does not survive a cluster: there is no repository on a node to mount, and "which
# revision of aas-export is running" becomes a property of whatever happens to be on disk rather
# than of the deployed artefact. Baking makes the functions version with the image, which is what
# lets a rollback actually roll the functions back. See docs/kubernetes-architecture.md §2.2.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, as the release workflow and the dev loop build it:
#   docker build -f supabase/functions/Dockerfile -t aber/edge-runtime:<tag> .
# Nothing outside supabase/functions/ is copied any more (the appliance's files reach the functions
# as a generated module under _shared/), so the context is a convention the two build sites share
# rather than a requirement.
#
# PINNED. The runtime and the functions are versioned together on purpose -- main/index.ts is an
# allow-list against a specific edge-runtime API.
#
# NOTHING IS FETCHED AT RUNTIME. deno.json declares the dependencies and deno.lock pins their bytes;
# the `modules` stage resolves them into a module cache the runtime reads, and the `offline-check`
# stage boots every function with no network. See supabase/README.md, "Edge function dependencies".

# The Deno that edge-runtime embeds (`edge-runtime --version`), so the cache and lock formats are
# the ones it reads. --frozen fails the build when deno.lock does not cover the module graph.
FROM denoland/deno:2.1.4 AS modules
ENV DENO_DIR=/deno-dir NO_COLOR=1
WORKDIR /functions
COPY supabase/functions .
RUN deno cache --frozen */index.ts

FROM supabase/edge-runtime:v1.77.0 AS runtime

ENV DENO_DIR=/home/deno/deno-dir
COPY --from=modules /deno-dir/npm /home/deno/deno-dir/npm
COPY --from=modules /deno-dir/remote /home/deno/deno-dir/remote

# The functions themselves, including main/ -- the allow-list stating what each one may reach. An
# unregistered function 404s before a worker spawns, so main/index.ts must ship alongside them.
# deno.json and deno.lock ship too: each worker finds them above its entrypoint and resolves
# through them.
COPY supabase/functions /home/deno/functions
# The build files copy themselves in with the rest of the directory; nothing dispatches to them.
RUN rm -f /home/deno/functions/Dockerfile /home/deno/functions/offline-check.sh

# The appliance's files (the compose project gateway-bundle zips up and the installer lays down)
# are NOT copied here: they are part of forge/gateway-platform/, which reaches the functions as the
# generated module _shared/gatewayPlatform.generated.ts, baked in with the rest of the code. A
# user worker has no filesystem access to anything in this image, and a module import is the one
# delivery that needs no entry in main/index.ts's allow-list.
#
# A user worker has NO FILESYSTEM ACCESS to anything in this image -- edge-runtime sandboxes it,
# and main/index.ts forwards only environment variables to each worker it spawns. ABER_CA_PEM is
# the platform's root, read here in the plain container shell before edge-runtime starts, from the
# ingress TLS Secret the chart mounts at /home/deno/ca when ingress TLS is on: gateway-bundle
# computes the one-liner's pin from it. Absent on a deployment without ingress TLS, and the
# dashboard then offers the ZIP bundle alone. Exec form with a literal script, so the quoting
# survives.
ENTRYPOINT ["/bin/sh", "-e", "-c", "export ABER_CA_PEM=\"$(cat /home/deno/ca/ca.crt 2>/dev/null || true)\"; exec edge-runtime start --main-service /home/deno/functions/main"]

FROM runtime AS offline-check
COPY supabase/functions/offline-check.sh /offline-check.sh
RUN --network=none bash /offline-check.sh > /offline-check.txt; s=$?; cat /offline-check.txt; exit $s

# The image is `runtime` plus the check's report, which makes the check a dependency of every build.
FROM runtime
COPY --from=offline-check /offline-check.txt /home/deno/offline-check.txt
