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
#   docker build -f supabase/functions/Dockerfile -t acs-cymru/edge-runtime:<tag> .
# Nothing outside supabase/functions/ is copied any more (the appliance's files reach the functions
# as a generated module under _shared/), so the context is a convention the two build sites share
# rather than a requirement.
#
# PINNED. The runtime and the functions are versioned together on purpose -- main/index.ts is an
# allow-list against a specific edge-runtime API.
FROM supabase/edge-runtime:v1.74.2

# The functions themselves, including main/ -- the allow-list stating what each one may reach. An
# unregistered function 404s before a worker spawns, so main/index.ts must ship alongside them.
COPY supabase/functions /home/deno/functions
# This file copies itself in with the rest of the directory. Harmless today -- main/index.ts is an
# allow-list, so nothing dispatches to it -- but a stray non-TypeScript file inside the functions
# root is exactly the sort of thing a future runtime's directory scan trips over.
RUN rm -f /home/deno/functions/Dockerfile

# The appliance's files (the compose project gateway-bundle zips up and the installer lays down)
# are NOT copied here: they are part of forge/gateway-platform/, which reaches the functions as the
# generated module _shared/gatewayPlatform.generated.ts, baked in with the rest of the code. A
# user worker has no filesystem access to anything in this image, and a module import is the one
# delivery that needs no entry in main/index.ts's allow-list.
#
# A user worker has NO FILESYSTEM ACCESS to anything in this image -- edge-runtime sandboxes it,
# and main/index.ts forwards only environment variables to each worker it spawns. ACS_CA_PEM is
# the platform's root, read here in the plain container shell before edge-runtime starts, from the
# ingress TLS Secret the chart mounts at /home/deno/ca when ingress TLS is on: gateway-bundle
# computes the one-liner's pin from it. Absent on a deployment without ingress TLS, and the
# dashboard then offers the ZIP bundle alone. Exec form with a literal script, so the quoting
# survives.
ENTRYPOINT ["/bin/sh", "-e", "-c", "export ACS_CA_PEM=\"$(cat /home/deno/ca/ca.crt 2>/dev/null || true)\"; exec edge-runtime start --main-service /home/deno/functions/main"]
