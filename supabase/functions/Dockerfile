# Edge functions, baked into an image rather than bind-mounted.
#
# WHY. docker-compose.yml mounts ./supabase/functions and ./node_red_flow.json into the stock
# supabase/edge-runtime image and assembles the rest in a shell entrypoint. That is right for
# Compose -- editing a function and restarting one container is the whole development loop -- but
# it does not survive the move to Kubernetes: there is no repository on a cluster node to mount,
# and "which revision of aas-export is running" becomes a property of whatever happens to be on
# disk rather than of the deployed artefact. Baking makes the functions version with the image,
# which is what lets a rollback actually roll the functions back.
#
# THE COMPOSE PATH IS UNCHANGED and keeps bind-mounting. Both run identical code; only the
# delivery differs. See docs/kubernetes-architecture.md §2.2.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not this directory:
#   docker build -f supabase/functions/Dockerfile -t acs-cymru/edge-runtime:<tag> .
# node_red_flow.json lives at the root and is the canonical flow deploy-nodered pushes, so it has
# to be reachable from the context. Building from supabase/functions/ instead fails on that COPY.
#
# PINNED to the tag docker-compose.yml runs. The runtime and the functions are versioned together
# on purpose -- main/index.ts is an allow-list against a specific edge-runtime API.
FROM supabase/edge-runtime:v1.74.2

# The functions themselves, including main/ -- the allow-list stating what each one may reach. An
# unregistered function 404s before a worker spawns, so main/index.ts must ship alongside them.
COPY supabase/functions /home/deno/functions
# This file copies itself in with the rest of the directory. Harmless today -- main/index.ts is an
# allow-list, so nothing dispatches to it -- but a stray non-TypeScript file inside the functions
# root is exactly the sort of thing a future runtime's directory scan trips over.
RUN rm -f /home/deno/functions/Dockerfile

# The canonical Node-RED flow: the "git" side of the GitOps sync deploy-nodered pushes to the
# running Node-RED.
COPY node_red_flow.json /home/deno/flows/node_red_flow.json

# The physical gateway bundle template -- the files gateway-bundle zips up and hands to an operator.
# Same delivery reasoning as the flow above: baked in, so which revision of the appliance template a
# release ships is a property of the artefact rather than of whatever is on a cluster node's disk.
COPY templates/physical-gateway /home/deno/templates/physical-gateway

# A user worker has NO FILESYSTEM ACCESS to anything in this image -- edge-runtime sandboxes it,
# and main/index.ts forwards only environment variables to each worker it spawns. So the flow and
# the bundle templates are read here, in the plain container shell before edge-runtime starts, and
# handed on through the environment. This is the same arrangement docker-compose.yml's entrypoint
# uses, moved into the image so the Kubernetes Deployment needs no command override at all.
#
# ONE VARIABLE PER FILE, with static names, because main/index.ts's FUNCTION_REGISTRY is an
# allow-list of variable NAMES -- a dynamically-built set could not be declared there, and that
# declaration is the one place "what may this code reach" is stated.
#
# Exec form with a literal script, so the nested quoting survives.
ENTRYPOINT ["/bin/sh", "-e", "-c", "export NODERED_FLOW_JSON=\"$(cat /home/deno/flows/node_red_flow.json)\"; T=/home/deno/templates/physical-gateway; export GW_BUNDLE_COMPOSE=\"$(cat $T/docker-compose.yml)\"; export GW_BUNDLE_DOCKERFILE=\"$(cat $T/Dockerfile)\"; export GW_BUNDLE_BOOTSTRAP=\"$(cat $T/bootstrap.mjs)\"; export GW_BUNDLE_FLOWS=\"$(cat $T/flows.template.json)\"; export GW_BUNDLE_README=\"$(cat $T/README.md)\"; exec edge-runtime start --main-service /home/deno/functions/main"]
