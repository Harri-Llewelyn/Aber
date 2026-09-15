{{/*
=================================================================================================
Shared template helpers.

This file exists because several services must be handed the SAME value, and a definition
repeated per service drifts the first time one of them is edited alone.

Four groups:
  1. Names and labels
  2. Validation  -- fail the render, not the pod
  3. Connection strings
  4. Environment blocks
=================================================================================================
*/}}

{{/* ---------------------------------------------------------------------------------------- */}}
{{/* 1. Names and labels                                                                        */}}
{{/* ---------------------------------------------------------------------------------------- */}}

{{- define "acs-cymru.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Release-qualified name, for objects that are NOT addressed by name from inside the stack
(Secrets, ConfigMaps, Jobs). Services deliberately do not use this -- see below.
*/}}
{{- define "acs-cymru.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
SERVICE NAMES ARE NOT PREFIXED, and that is the chart's central design decision rather than an
oversight. Service names are the component names, so in-cluster DNS resolves
`http://supabase-kong:8000`, `timescaledb:5432` and `mosquitto:1883` -- the URLs grafana.ini,
settings.js and the edge-function environment carry.

Prefixing them with the release name would break all of that and buy nothing: two releases of this
stack in one namespace is not a supported configuration (they would contend for the MQTT host
port, the Realtime replication slot and the tenant name). Use two namespaces.

Do not "tidy" a Service name. deploy/k8s/README.md carries the divergence table this belongs to.
*/}}
{{- define "acs-cymru.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "acs-cymru.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: acs-cymru
{{- with .Values.global.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* Selector labels for one component. Usage: (dict "ctx" $ "component" "timescaledb") */}}
{{- define "acs-cymru.selectorLabels" -}}
app.kubernetes.io/name: {{ include "acs-cymru.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "acs-cymru.componentLabels" -}}
{{ include "acs-cymru.labels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "acs-cymru.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "acs-cymru.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* Resolve a per-component storageClass, falling back to the global one. */}}
{{- define "acs-cymru.storageClass" -}}
{{- $sc := .component.storageClass | default .ctx.Values.global.storageClass -}}
{{- if $sc -}}
storageClassName: {{ $sc | quote }}
{{- end -}}
{{- end -}}

{{/*
Render a `repository:tag` image reference, defaulting an EMPTY tag to the chart's appVersion.

Used only by the images this repository BUILDS -- edge-runtime, ingestion, node-red, frontend,
test-runner and i3x-service. Their tag is empty in values.yaml on purpose, so the chart and the
images it names ship from one release tag and cannot drift: .github/workflows/release.yml stamps
appVersion from the `v*` tag and pushes all of them at the same string, in the same run.

It is deliberately NOT used for third-party images. Those pins are decisions, several of them
load-bearing -- supabase/realtime and supabase/storage-api migrate shared schemas on boot,
supabase/studio is Zod-coupled to a postgres-meta version, nodered/node-red is what the generated
settings.js depends on. Floating any of them onto our appVersion would mean bumping this chart
silently changed which Postgres the databases run, which is the opposite of what a pin is for.

An explicit `tag` still wins, so a deployment can pull one component at a different build (a hotfix,
a bisect, a locally-built image) without forking the chart.

  {{ include "acs-cymru.image" (dict "image" .Values.ingestion.image "ctx" .) }}
*/}}
{{- define "acs-cymru.image" -}}
{{- $tag := .image.tag | default .ctx.Chart.AppVersion -}}
{{- if not $tag -}}
{{- fail "image tag resolved to empty: Chart.yaml has no appVersion and no explicit tag was set" -}}
{{- end -}}
{{- printf "%s:%s" .image.repository $tag -}}
{{- end -}}

{{/*
The Prometheus and Loki the Grafana datasources point at.

Empty in values resolves to the chart's own stores when observability.enabled; with it off, an
empty value fails the render, because a datasource pointed at nothing gives every alert rule
DatasourceError against a stack that is otherwise healthy.
*/}}
{{- define "acs-cymru.prometheusUrl" -}}
{{- if .Values.grafana.prometheusUrl -}}
{{- .Values.grafana.prometheusUrl -}}
{{- else if .Values.observability.enabled -}}
http://prometheus:9090
{{- else -}}
{{- fail "\n\nacs-cymru: grafana.prometheusUrl is empty and observability.enabled is false.\n\nEither enable the chart's own stack or set grafana.prometheusUrl to the cluster's Prometheus.\n" -}}
{{- end -}}
{{- end -}}

{{- define "acs-cymru.lokiUrl" -}}
{{- if .Values.grafana.lokiUrl -}}
{{- .Values.grafana.lokiUrl -}}
{{- else if .Values.observability.enabled -}}
http://loki:3100
{{- else -}}
{{- fail "\n\nacs-cymru: grafana.lokiUrl is empty and observability.enabled is false.\n\nEither enable the chart's own stack or set grafana.lokiUrl to the cluster's Loki.\n" -}}
{{- end -}}
{{- end -}}

{{/*
Pod annotations that make a workload a scrape target. Alloy (templates/obs/alloy.yaml) keeps
every pod in the release carrying `prometheus.io/scrape: "true"`, reads the port and path from
the other two, and labels the series `service` with the pod's component. The convention is the
one most Prometheus configurations already read, so a cluster's own Prometheus can use it too.

  {{ include "acs-cymru.scrapeAnnotations" (dict "port" 9108 "path" "/metrics") | nindent 8 }}
*/}}
{{- define "acs-cymru.scrapeAnnotations" -}}
prometheus.io/scrape: "true"
prometheus.io/port: {{ .port | quote }}
prometheus.io/path: {{ .path | default "/metrics" | quote }}
{{- end -}}

{{/* ---------------------------------------------------------------------------------------- */}}
{{/* 2. Validation                                                                              */}}
{{/*                                                                                            */}}
{{/* Every check here FAILS THE RENDER. That is the point: each of these misconfigurations       */}}
{{/* otherwise produces a stack that reports healthy and then refuses every request, or a        */}}
{{/* CrashLoopBackOff whose logs name something other than the cause.                            */}}
{{/* ---------------------------------------------------------------------------------------- */}}

{{/*
The Supabase credentials are a SET.

`anonKey` and `serviceRoleKey` are JWTs signed by `jwtSecret`; `publishableKey` and `secretKey`
are the keys callers present, which the gateway translates to those JWTs. Generating one without
the others invalidates the rest, and every request then fails at the gateway against a stack that
looks fine. So: all supplied, or none and a legible refusal. The chart never generates them.

Skipped entirely when `existingSecret` is set, because the values are then not the chart's to see.
*/}}
{{- define "acs-cymru.validateSecrets" -}}
{{- if not .Values.secrets.existingSecret -}}
{{- $missing := list -}}
{{- range $field, $envName := dict "jwtSecret" "SUPABASE_JWT_SECRET" "anonKey" "SUPABASE_ANON_KEY" "serviceRoleKey" "SUPABASE_SERVICE_ROLE_KEY" "publishableKey" "SUPABASE_PUBLISHABLE_KEY" "secretKey" "SUPABASE_SECRET_KEY" "postgresPassword" "POSTGRES_PASSWORD" -}}
{{- if not (get $.Values.secrets $field) -}}
{{- $missing = append $missing (printf "secrets.%s (%s)" $field $envName) -}}
{{- end -}}
{{- end -}}
{{/*
GRAFANA NEEDS THE BI READER PASSWORD, and only Grafana does -- the maintenance Job treats an empty
value as "do not create the role", which is the right behaviour for a stack with no reporting tool
attached. With Grafana enabled it is not optional: its render-datasource initContainer refuses to
start without one, and the fallback it used to have -- the `postgres` superuser credential -- is
exactly what this replaced. Caught here so the failure is one Helm error rather than a Grafana pod
in CrashLoopBackOff reporting a database it cannot authenticate against.
*/}}
{{- if and .Values.grafana.enabled (not .Values.secrets.biReaderPassword) -}}
{{- $missing = append $missing "secrets.biReaderPassword (BI_READER_PASSWORD, required when grafana.enabled)" -}}
{{- end -}}
{{- if and (eq (.Values.ingestion.dbUser | default "") "ingest_writer") (not .Values.secrets.ingestWriterPassword) -}}
{{- $missing = append $missing "secrets.ingestWriterPassword (INGEST_WRITER_PASSWORD, required while ingestion.dbUser is ingest_writer -- the role does not exist without it, and the only other historian credential is the superuser)" -}}
{{- end -}}
{{/*
  THE TWO MACHINE-PRINCIPAL KEYS, and they are here because their absence is the WORST failure
  shape this helper exists to prevent: not a template error, and not a stack that rejects requests,
  but a `helm install` that reports success while a pod halts itself and reports `0 of 1 updated
  replicas are available` for ten minutes. The ingestion daemon refuses to start its MQTT loop
  without SUPABASE_INGESTION_KEY -- correctly, since running fail-open would let unquarantined
  devices through -- and the message names neither the chart nor the values file.

  Unconditional, because neither workload has an `enabled` flag: the chart always deploys both.
*/}}
{{- if not .Values.secrets.ingestionKey -}}
{{- $missing = append $missing "secrets.ingestionKey (SUPABASE_INGESTION_KEY, required -- the ingestion daemon halts rather than start its MQTT loop without it, so the stack installs and then never becomes ready)" -}}
{{- end -}}
{{- if not .Values.secrets.playbackKey -}}
{{- $missing = append $missing "secrets.playbackKey (SUPABASE_PLAYBACK_KEY, required -- Service_Playback is the identity broker playback publishes under, and it is deliberately not service_role)" -}}
{{- end -}}
{{- if not .Values.secrets.fdwReaderPassword -}}
{{- $missing = append $missing "secrets.fdwReaderPassword (FDW_READER_PASSWORD, required -- Supabase's postgres_fdw mapping authenticates as fdw_reader, and the only alternative is the historian superuser)" -}}
{{- end -}}
{{/*
THE CREDENTIAL SERVICE'S TOKEN, for the same reason one line up and with a worse blast radius.

It exits 2 on anything shorter than 32 characters rather than running open -- correctly, because it
can issue a Mosquitto account for any edge node and the gateway's role turns an account into the
ability to publish Sparkplug telemetry AS that gateway. There is no safe default to fall back to.

But it is a SIDECAR IN THE BROKER'S POD, so its refusal is not contained the way Grafana's would
be: the pod never reaches Ready, and every workload that waits on the broker -- ingestion,
i3x-service, both e2e Jobs -- times out against a broker that is running perfectly well. The
rollout error then names i3x-service, which is neither the cause nor anywhere near it.

32, not "not empty", because the length is the check the service actually applies.
*/}}
{{- if and .Values.gatewayCredential.enabled (lt (len (.Values.secrets.mqttCredentialServiceToken | default "")) 32) -}}
{{- $missing = append $missing "secrets.mqttCredentialServiceToken (MQTT_CREDENTIAL_SERVICE_TOKEN, 32+ characters, required when gatewayCredential.enabled)" -}}
{{- end -}}
{{/*
THE PLUGIN'S ADMIN. The broker's initContainer writes this account into the Dynamic Security
document on every start and exits 1 without a password, so the pod never starts and the symptom is
the same rollout timeout as above. The credential service authenticates as it; nothing else does.
*/}}
{{- if and .Values.mosquitto.enabled (not .Values.secrets.mqttDynsecAdminPassword) -}}
{{- $missing = append $missing "secrets.mqttDynsecAdminPassword (MQTT_DYNSEC_ADMIN_PASSWORD, required -- the account the credential service administers the broker's Dynamic Security plugin as)" -}}
{{- end -}}
{{/*
CONDITIONAL, LIKE THE TOKEN ABOVE, because playback is off by default and a cluster that never
enables it needs no key at all.

The failure this catches is quiet in the way this whole block exists for: playback_worker.py refuses
to start without the key, so the pod CrashLoopBackOffs -- which is at least visible -- but the
message names an environment variable rather than the values key that fills it, and the operator who
set `playback.enabled: true` has no reason to connect the two. `mqttPlaybackCredentials` is NOT
required beside it: a worker with no broker credentials is a correct state for a stack that has
issued no playback targets yet.
*/}}
{{- if and .Values.playback.enabled (not .Values.secrets.playbackKey) -}}
{{- $missing = append $missing "secrets.playbackKey (SUPABASE_PLAYBACK_KEY, required when playback.enabled -- a JWT signed by jwtSecret for subject b0000000-0000-4000-8000-000000000003, Service_Playback)" -}}
{{- end -}}
{{- if $missing -}}
{{- fail (printf "\n\nacs-cymru: required credentials are not set:\n  - %s\n\nThese are a SET, not independent values: anonKey and serviceRoleKey are JWTs signed by\njwtSecret and publishableKey and secretKey are the keys the gateway translates to them, so\nsupplying some and not others yields a stack that reports healthy and rejects every request\nat the gateway. The chart deliberately does not generate them.\n\nFor a local k3s stack:   helm install ... -f values-dev.yaml\nFor anything else:       copy values-prod.yaml.example and supply a matching set.\n" (join "\n  - " $missing)) -}}
{{- end -}}
{{/*
THE DEMO SECRET IS REFUSED ON ANYTHING THAT IS NOT PLAINLY LOCAL.

`values-dev.yaml` legitimately carries the published Supabase demo credentials, and CI installs
with it every run — so this cannot simply ban the value. What it bans is the combination that has
no innocent reading: the demo JWT secret together with a public hostname somebody chose.

A deployment on the demo set is one where the published keys in this repository authenticate
at the edge, and the giveaway is precisely that nothing looks wrong: every pod is healthy, every
request succeeds, and the credentials are in a file thousands of people already have.

The local forms below are the ones the chart's own docs and CI use; anything else is taken to be
a deployment other people can reach. Overriding this by editing the list is not a workaround —
`node scripts/setup.mjs` mints a matching set in one command, and `values-prod.yaml.example`
documents where to put it.
*/}}
{{- $demoJwtSecret := "super-secret-jwt-token-with-at-least-32-characters" -}}
{{- if eq (.Values.secrets.jwtSecret | default "") $demoJwtSecret -}}
{{- $domain := .Values.global.publicBaseDomain | default "" -}}
{{- $isLocal := or (empty $domain) (contains "127.0.0.1" $domain) (contains "localhost" $domain) (contains "192.168." $domain) (hasSuffix ".local" $domain) (hasSuffix ".localhost" $domain) (hasSuffix ".internal" $domain) -}}
{{- if not $isLocal -}}
{{- fail (printf "\n\nacs-cymru: refusing to install on the PUBLISHED demo credentials with a public hostname.\n\n  global.publicBaseDomain = %s\n  secrets.jwtSecret       = the Supabase demo value, committed in this repository\n\nanonKey and serviceRoleKey are signed by that secret, so this deployment would authenticate\nanyone holding a file that ships with the source.\n\nGenerate a matching set:\n\n  node scripts/setup.mjs        # writes values-local.yaml with a fresh, internally consistent set\n\nthen install with -f values-local.yaml (or carry the four values into your own values file, see\nvalues-prod.yaml.example), or set\nsecrets.existingSecret to a Secret managed outside the chart.\n\nIf this really is a private lab, name it as one -- a publicBaseDomain under 127.0.0.1.nip.io,\nlocalhost, 192.168.*, .local, .localhost or .internal is accepted as-is.\n" $domain) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Realtime's two keys have LENGTHS ENFORCED BY THE CONTAINER, which refuses to boot otherwise --
dbEncKey exactly 16 characters, secretKeyBase at least 64. Asserted here so the failure is one
Helm error instead of a restarting pod with an Elixir stacktrace.

Only checked when realtime is enabled AND the chart owns the secret.
*/}}
{{- define "acs-cymru.validateRealtime" -}}
{{- if and .Values.realtime.enabled (not .Values.secrets.existingSecret) -}}
{{- $enc := .Values.secrets.realtimeDbEncKey | default "" -}}
{{- $base := .Values.secrets.realtimeSecretKeyBase | default "" -}}
{{- if ne (len $enc) 16 -}}
{{- fail (printf "\n\nacs-cymru: secrets.realtimeDbEncKey must be EXACTLY 16 characters (got %d).\nsupabase/realtime refuses to boot otherwise. Generate one with:  openssl rand -hex 8\n" (len $enc)) -}}
{{- end -}}
{{- if lt (len $base) 64 -}}
{{- fail (printf "\n\nacs-cymru: secrets.realtimeSecretKeyBase must be AT LEAST 64 characters (got %d).\nsupabase/realtime refuses to boot otherwise. Generate one with:  openssl rand -hex 32\n" (len $base)) -}}
{{- end -}}
{{/*
  THE THIRD SECRET THAT MAKES REALTIME REFUSE TO BOOT, beside the other two by this block's own
  logic rather than as a new idea. `METRICS_JWT_SECRET` became mandatory in v2.102.3 --
  `System.fetch_env!`, so the container aborts during boot rather than defaulting. Unset, the pod
  CrashLoopBackOffs and the only clue is an Elixir stack trace ten frames deep.

  secret.yaml gained the value when the version was pinned -- but NOTHING CONSUMED IT. The chart carried the secret and never passed it to
  the pod. This is what stops that being possible again.

  No length rule: unlike the two above, it only has to exist and be secret.
*/}}
{{- if not .Values.secrets.realtimeMetricsJwtSecret -}}
{{- fail "\n\nacs-cymru: secrets.realtimeMetricsJwtSecret is required (METRICS_JWT_SECRET).\nsupabase/realtime v2.102.3 refuses to boot otherwise. Generate one with:  openssl rand -hex 32\n\nDeliberately NOT secrets.jwtSecret: it signs the bearer token realtime's /metrics endpoint\nrequires, and sharing the API signing key would let anyone holding it mint metrics tokens.\n" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Realtime's Service name must have `realtime-dev` as its LEADING LABEL.

Realtime reads the tenant id from the leading hostname label of the Host header, not from the JWT.
The gateway rewrites the upstream Host to the Service name -- rename it and every WebSocket
handshake fails with a bare 403 that names nothing.
*/}}
{{- define "acs-cymru.validateRealtimeServiceName" -}}
{{- if .Values.realtime.enabled -}}
{{- $name := .Values.realtime.serviceName | default "" -}}
{{- if not (or (eq $name "realtime-dev") (hasPrefix "realtime-dev." $name)) -}}
{{- fail (printf "\n\nacs-cymru: realtime.serviceName must be `realtime-dev` (got %q).\n\nRealtime resolves its TENANT from the leading hostname label of the Host header, and\n`realtime-dev` is the tenant SEED_SELF_HOST creates. Any other name makes every WebSocket\nhandshake fail with a bare 403 that does not mention the tenant. See plan §3.4.\n" $name) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
A browser-facing URL that resolves to the empty string is worse than a missing one.

GoTrue builds every user-facing redirect from GOTRUE_SITE_URL, including the OAuth consent
redirect; empty means /oauth/authorize sends the browser to `/oauth/consent` with no origin, and
Grafana and Node-RED SSO both fail at the consent step with nothing naming the cause. The OAuth
`redirect_uris` db-init registers would be empty too, so the clients could never match.

A data-tier-only install genuinely does not need a domain, which is why this is gated on
supabaseAuth rather than asserted unconditionally.
*/}}
{{- define "acs-cymru.validatePublicUrls" -}}
{{- if .Values.supabaseAuth.enabled -}}
{{- $missing := list -}}
{{- if not (include "acs-cymru.frontendUrl" .) }}{{ $missing = append $missing "frontend (app.<domain>)" }}{{- end -}}
{{- if not (include "acs-cymru.supabaseUrl" .) }}{{ $missing = append $missing "supabase (api.<domain>)" }}{{- end -}}
{{- if $missing -}}
{{- fail (printf "\n\nacs-cymru: no browser-facing URL could be resolved for:\n  - %s\n\nSet global.publicBaseDomain (every host is derived from it), or set publicUrls.* explicitly.\n\nThis is not cosmetic. GoTrue builds every user-facing redirect from GOTRUE_SITE_URL, and an empty\none sends the browser to a path with no origin -- Grafana and Node-RED SSO then fail at the consent\nstep with nothing naming the cause. The OAuth redirect_uris db-init registers would be empty too,\nso no client could ever match one.\n" (join "\n  - " $missing)) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
TLS on the ingress and `scheme: http` is a contradiction that fails as an OAuth error.

Every browser-facing URL is composed from `global.scheme`, and db-init registers those URLs as the
OAuth clients' `redirect_uris`. With TLS terminating at the ingress the browser arrives over https
and presents an https redirect_uri, while GoTrue holds the http one it was given -- and answers
`invalid redirect_uri`, which reads as a Grafana or Node-RED fault. Grafana's own root_url would be
wrong in the same breath, so it would redirect users to http and lose the session cookie.

Nothing crashes and no pod reports unhealthy: only sign-in breaks.
*/}}
{{- define "acs-cymru.validateScheme" -}}
{{- if and .Values.ingress.enabled .Values.ingress.tls.enabled (ne .Values.global.scheme "https") -}}
{{- fail (printf "\n\nacs-cymru: ingress.tls.enabled is true but global.scheme is %q.\n\nEvery browser-facing URL -- and therefore every OAuth redirect_uri db-init registers -- is composed\nfrom global.scheme. With TLS terminating at the ingress the browser arrives over https and presents\nan https redirect_uri, while GoTrue holds the http one: /oauth/authorize answers `invalid\nredirect_uri`, and it reads as a Grafana or Node-RED fault. Grafana's root_url would send users to\nhttp as well, losing the session cookie.\n\nNothing crashes -- only sign-in breaks. Set global.scheme: https.\n" .Values.global.scheme) -}}
{{- end -}}
{{- end -}}

{{/*
An enabled ingress that resolved no hostname.

An `Ingress` with empty `host:` fields is ACCEPTED by the API server and then matches every request
arriving at the controller -- so unrelated traffic reaches the dashboard while none of the intended
hostnames route at all.

CHECKED HERE RATHER THAN IN ingress.yaml, and the ordering is the reason. A `fail` inside a resource
template pre-empts this whole chain, so an install with no credentials at all was being told about
hostnames -- true, but the third-most useful thing to say. Validation belongs in one ordered place;
ingress.yaml simply renders nothing when there is nothing to render.
*/}}
{{- define "acs-cymru.validateIngress" -}}
{{- if .Values.ingress.enabled -}}
{{- $hosts := list -}}
{{- range (include "acs-cymru.ingressRoutes" . | fromYamlArray) -}}
{{- if .host }}{{ $hosts = append $hosts .host }}{{ end -}}
{{- end -}}
{{- if not $hosts -}}
{{- fail "\n\nacs-cymru: ingress.enabled is true but no route resolved a hostname.\n\nEvery host is derived from global.publicBaseDomain (or an explicit publicUrls.* entry). With neither\nset this would render an Ingress with empty `host:` fields -- which the API server ACCEPTS, and which\nthen matches EVERY request arriving at the controller, so unrelated traffic reaches the dashboard and\nnone of the intended hostnames route.\n\nSet global.publicBaseDomain, or ingress.enabled=false to run the stack cluster-internal only.\n" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
The single-writer workloads, and why each one is.

ONE LIST, READ RATHER THAN RESTATED. `acs-cymru.validateAutoscaling` below derives its refusal set
from this block, and CI's replica/strategy check parses this same block out of the file. Neither
keeps its own copy, because a copy is how this list came to be wrong: it named `i3x-service` from the
day it was written, the guard hardcoded a duplicate that did not, and nothing compared them -- so the
one workload whose in-memory state makes a second replica CLIENT-VISIBLE was the one the guard would
have let through (issue #27).

PARSED AS YAML, so the shape matters: `name: reason`, with continuation lines indented. The KEY is
the name `autoscaling.components` takes, which for the Supabase components is the unprefixed one --
`realtime`, not `supabase-realtime`. CI resolves both spellings against the rendered manifests and
treats a name that matches NEITHER as an error rather than skipping it, because a name nothing
resolves to protects nothing and would do so silently.
*/}}
{{- define "acs-cymru.singleWriterWorkloads" -}}
ingestion: a plain paho subscribe with no shared-subscription group -- every replica consumes every
  message, so a second one duplicates telemetry, quarantine decisions and append-only audit rows
i3x-service: the same unshared spBv1.0/# subscription, AND its subscription state (queues, sequence
  numbers, open SSE streams) is in memory -- a second replica answers /subscriptions/sync for a
  subscriptionId it has never seen, so a live client gets an intermittent 404 depending on which pod
  the Service picked
node-red: single-writer /data (the live flow, the encrypted credentials, editor sessions and the
  persisted editor-user map)
mosquitto: does not cluster -- two brokers behind one Service split the fleet, and Sparkplug state
  is per-connection
realtime: holds a logical replication slot, which is per-instance state
supabase-storage: the file backend is a single writer on a ReadWriteOnce PVC
grafana: the default backend is a SQLite file on a ReadWriteOnce PVC
gitea: SQLite plus a repository directory on one ReadWriteOnce PVC -- and the repositories are the
  half that makes a second replica worse than useless, since two processes writing one git object
  store corrupt it rather than merely contending for it
supabase-db: a single Postgres instance with no replication; HA needs an operator
timescaledb: likewise
prometheus: one TSDB on a ReadWriteOnce PVC; a second instance would also be a second remote-write
  target, and the DaemonSet writes to one Service
loki: single-binary mode with filesystem storage on a ReadWriteOnce PVC -- the ingester, the index
  and the chunks are all local files
{{- end -}}

{{/*
The workloads that MAY autoscale, and why each is safe to run more than one of.

THE COMPLEMENT OF THE BLOCK ABOVE IS NOT AN ANSWER, which is why this is written out rather than
derived. "Not single-writer" includes every name that does not exist -- a typo, a component that
was renamed, a workload this chart has never shipped -- and issue #31 is precisely that those all
used to pass. An allow-list is the only shape where an unrecognised name is wrong by default.

Read by `acs-cymru.validateAutoscaling` and by hpas.yaml, which asserts its own dispatch table
matches these keys -- so the set exists once and the two cannot drift apart.
*/}}
{{- define "acs-cymru.autoscalableWorkloads" -}}
supabase-rest: PostgREST is stateless and holds a connection pool per replica
supabase-envoy: the gateway is configured declaratively and holds no state between requests. `supabase-kong` was listed beside it for the side-by-side migration and is gone with Kong itself (b7989a0); the Service keeps that name, but there is no second gateway to scale
supabase-functions: the edge runtime is a request router whose workers are per-request isolates
frontend: NGINX serving static files
{{- end -}}

{{/*
An HPA on a workload that must not have one.

TWO REFUSALS, AND THE SECOND IS THE ONE ISSUE #31 WAS ABOUT.

  1. A SINGLE-WRITER workload. Every one is one replica for a reason recorded in its own manifest,
     and the damage from scaling it is SILENT -- no error, no crash, just duplicated telemetry, a
     split fleet, or two processes racing on one volume. An autoscaler makes that happen at 3am
     under load, which is the worst possible moment to discover it.

  2. A name that is NEITHER allowed nor forbidden. This used to render no HPA and no error, so
     `superbase-rest` -- a typo -- installed cleanly and simply never scaled. The symptom arrives
     months later as a component that "should be autoscaling and isn't", with nothing logged at
     install time to search for. It also meant the forbidden list was the only protection a
     single-writer workload had, so any one missing from it was unguarded; `i3x-service` was
     missing until #27.

The order matters: forbidden is checked first so a single-writer workload keeps its specific
explanation rather than being reported as merely unrecognised.
*/}}
{{- define "acs-cymru.validateAutoscaling" -}}
{{- if .Values.autoscaling.enabled -}}
{{- $single := include "acs-cymru.singleWriterWorkloads" . | fromYaml -}}
{{- $forbidden := keys $single -}}
{{- $allowed := keys (include "acs-cymru.autoscalableWorkloads" . | fromYaml) -}}
{{- if lt (len $allowed) 4 -}}
{{/*
  THE SAME PARSE TRAP AS BELOW, in the direction that fails CLOSED rather than open: an
  unparseable allow-list would leave `$allowed` empty and refuse every component, including the
  four that are correct. Loud either way, but worth naming so the message points at the block
  rather than at the operator's values file.
*/}}
{{- fail (printf "\n\nacs-cymru: the autoscalable workload list did not parse -- got %d entries: %v.\n\nThis guard derives its allow-list from `acs-cymru.autoscalableWorkloads` in _helpers.tpl, which\nis read as YAML. Check that block for a broken indent or a stray colon.\n" (len $allowed) $allowed) -}}
{{- end -}}
{{- if lt (len $forbidden) 9 -}}
{{/*
  A PARSE FAILURE MUST NOT READ AS "NOTHING IS FORBIDDEN". `fromYaml` answers a map carrying an
  `Error` key rather than failing, so a typo in the block above would silently empty this guard and
  every single-writer workload would become autoscalable with no error anywhere. Checked against a
  floor rather than an exact count, so that adding a workload does not mean editing two places --
  which is the whole point of deriving the list.
*/}}
{{- fail (printf "\n\nacs-cymru: the single-writer workload list did not parse -- got %d entries: %v.\n\nThis guard derives its refusal set from `acs-cymru.singleWriterWorkloads` in _helpers.tpl, which\nis read as YAML. An unparseable block would leave the guard EMPTY and every single-writer\nworkload autoscalable, with no error, so it fails here instead. Check that block for a broken\nindent or a stray colon.\n" (len $forbidden) $forbidden) -}}
{{- end -}}
{{- range .Values.autoscaling.components -}}
{{- if has . $forbidden -}}
{{/*
  THE COMPONENT'S OWN REASON IS PRINTED, not a representative one. The message used to explain
  `ingestion` whatever had been asked for, so someone who set `grafana` read an answer about
  duplicated telemetry rows and had to work out for themselves that theirs was a SQLite file on a
  ReadWriteOnce volume. The reasons are already written per-component one define up.
*/}}
{{- fail (printf "\n\nacs-cymru: autoscaling.components includes %q, which is a SINGLE-WRITER workload.\n\nWhy this one cannot be scaled:\n  %s\n\nRefused rather than warned about, because the damage is SILENT -- no error, no crash, just wrong\ndata or a split fleet. An autoscaler makes that happen under load, which is the worst moment to\ndiscover it.\n\nOnly these may autoscale: %s.\n" . (get $single .) (join ", " $allowed)) -}}
{{- end -}}
{{- if not (has . $allowed) -}}
{{/*
  ISSUE #31. Reached only when the name is in neither list, which is the case that used to render
  nothing and say nothing.
*/}}
{{- fail (printf "\n\nacs-cymru: autoscaling.components includes %q, which is not a component this chart can scale.\n\nIt is neither in the allow-list nor among the single-writer workloads, so it would previously have\nrendered NO HPA AND NO ERROR -- indistinguishable from a correct value that happened to produce\nnothing. A typo such as `superbase-rest` installed cleanly and then never scaled, and the symptom\narrived months later under load with nothing logged at install time to search for.\n\nOnly these may autoscale: %s.\n\nIf %q is a real workload that SHOULD scale, add it to `acs-cymru.autoscalableWorkloads` in\n_helpers.tpl with the reason it is safe to run more than one of -- and to hpas.yaml's dispatch\ntable, which is checked against that same list.\n" . (join ", " $allowed) .) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Broker TLS, and the two ways of asking for a broker nobody can reach.

BOTH ARE REFUSED RATHER THAN RENDERED, because both produce a stack that reports entirely healthy:

  1. `external.plaintext: false` with TLS OFF leaves the external Service with NO PORTS. That is
     invalid to the API server, so this one at least fails -- but it fails as
     "spec.ports: Required value" on a Service, which names neither setting. Anyone who genuinely
     wants no external broker wants `external.enabled: false`.

  2. TLS on, external LoadBalancer, and the certificate carrying NOTHING a gateway could match --
     no IP SAN and no operator-supplied DNS SAN either. In-cluster clients dial `mosquitto` and
     verify perfectly; every gateway dials the IP and fails on a hostname mismatch the broker never
     logs. So the stack reports healthy, the simulator keeps producing telemetry, and the fleet is
     off -- which reads as a gateway or network fault, nowhere near this setting.

     Refused rather than warned about, for the same reason as the autoscaling list: Helm has no
     non-fatal warning that `helm template` would surface, so a "warning" here is either an abort or
     nothing at all. And the condition is narrow enough to be unambiguous -- `publicBaseDomain`
     alone does not satisfy it, because `mqtt.<domain>` is the WebSocket name, not the address a
     gateway dials. Supplying EITHER an IP SAN or an explicit DNS SAN clears it, so a deployment
     behind plant DNS is not blocked; only one with no external identity at all.
*/}}
{{- define "acs-cymru.validateBrokerTls" -}}
{{- if .Values.mosquitto.enabled -}}
{{- if and .Values.mosquitto.external.enabled (not .Values.mosquitto.external.plaintext) (not .Values.mosquitto.tls.enabled) -}}
{{- fail "\n\nacs-cymru: mosquitto.external.plaintext=false with mosquitto.tls.enabled=false.\n\nThat asks for an external broker Service with no ports on it at all -- 1883 withdrawn and 8883 never\nadded. The API server would refuse it as `spec.ports: Required value`, which names neither setting.\n\nEither turn TLS on (see deploy/k8s/internal-ca.yaml), or set mosquitto.external.enabled=false if the\nintent is no external broker at all.\n" -}}
{{- end -}}
{{- if and .Values.mosquitto.tls.enabled .Values.mosquitto.external.enabled (eq .Values.mosquitto.external.type "LoadBalancer") -}}
{{- if and (eq (toString .Values.mosquitto.external.loadBalancerIP) "") (not .Values.mosquitto.tls.extraIpSans) (not .Values.mosquitto.tls.extraDnsSans) -}}
{{- fail (printf "\n\nacs-cymru: broker TLS is on with an external LoadBalancer, but the certificate would carry no\nexternal identity -- no IP SAN and no DNS SAN beyond the in-cluster name.\n\nGateways dial the broker BY ADDRESS; there is rarely plant DNS for it. A certificate with no IP SAN\nfails verification on every gateway while the in-cluster clients -- which connect to `mosquitto` --\nverify perfectly. The stack reports healthy, the demo simulator keeps producing telemetry, and the\nfleet is silently off.\n\nOnce the cluster has assigned the address:\n\n  kubectl -n %s get svc mosquitto-external -o jsonpath='{.status.loadBalancer.ingress[0].ip}'\n\nthen set ONE of:\n  mosquitto.tls.extraIpSans={<that address>}      # gateways dial the IP (usual case)\n  mosquitto.external.loadBalancerIP=<address>     # pin it, and it is added to the SANs for you\n  mosquitto.tls.extraDnsSans={mqtt.plant.example} # gateways dial a plant DNS name\n" .Release.Namespace)  -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Single entry point, included once from NOTES.txt so every render runs every check.

ORDER IS DELIBERATE, most fundamental first: a stack with no credentials should be told that, not
told about the hostnames it also lacks.
*/}}
{{/*
The two GATEWAY MQTT usernames must be well-formed sparkplug_ids, and the monitoring account must
have a password.

WHY THE RENDER AND NOT THE POD. A gateway account's role confines it to
`spBv1.0/+/+/<username>/#` (mosquitto/dynsec-roles.json, and the per-gateway role the reconcile
generates), and `verify_gateway_binding()` requires that same segment to be the gateway row's
GENERATED `sparkplug_id`. So a friendly username here does not fail: the client authenticates
perfectly, and then the broker silently drops every message it publishes. Nothing logs a reason at
either end -- the symptom is an edge node that connects and produces no telemetry, which reads as a
broken simulator or a broken ingestion daemon.

The monitoring password is checked because the broker's own probes authenticate as that account:
an empty one leaves the pod permanently NotReady and takes down every workload that waits on it,
reporting nothing about MQTT.

Skipped when `existingSecret` is set -- the values are then not the chart's to see.
*/}}
{{- define "acs-cymru.validateMqttPrincipals" -}}
{{- if not .Values.secrets.existingSecret -}}
{{- range $field := list "mqttValidatorUser" -}}
{{- $v := get $.Values.secrets $field -}}
{{- if not (regexMatch "^gwy[0-9a-f]{21}$" $v) -}}
{{- fail (printf "\n\nacs-cymru: secrets.%s is %q, which is not a gateway sparkplug_id.\n\nIt must be 'gwy' followed by exactly 21 lowercase hex characters. The broker confines a gateway\naccount to `spBv1.0/+/+/<username>/#`, and ingestion's verify_gateway_binding() requires that same\ntopic segment to be the gateway row's GENERATED sparkplug_id -- so any other value AUTHENTICATES\nFINE and then has every published message silently dropped by the broker, with nothing logged at\neither end.\n\nThe id is derived from the row's pinned UUID: 'gwy' + the first 21 hex characters of it.\n  10000000-0000-4000-8000-000000000001 -> gwy100000000000400080000  (Virtual_Gateway_NodeRED)\n  11000000-0000-4000-8000-000000000001 -> gwy110000000000400080000  (validate.py's gateway)\n" $field $v) -}}
{{- end -}}
{{- end -}}
{{- if not .Values.secrets.mqttMonitorPassword -}}
{{- fail "\n\nacs-cymru: secrets.mqttMonitorPassword is empty.\n\nThe broker's startup, readiness and liveness probes authenticate as this account (it can read\n$SYS and publish nothing). Without it mosquitto never becomes Ready, and every workload that\nwaits on it fails to start -- an outage whose events mention neither MQTT nor this setting.\n" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Publishing Studio requires the credentials that make it a door rather than a hole.

`ingress.routes.studio` names the GATEWAY's studio listener, so the console is behind an OAuth flow
and an `Administrator` check -- but only if that flow has a client to run. With the secrets unset the
gateway substitutes credentials that cannot authenticate and 0081 registers no client, so the route
publishes a hostname whose every request ends at a login nobody can complete.

THAT IS NOT A SECURITY FAILURE, and it is refused anyway. Fail-closed is the right RUNTIME behaviour
for a stack that was upgraded before the variables existed; it is the wrong INSTALL behaviour for an
operator who has just asked for the route by name, because the symptom -- a redirect loop through
GoTrue ending in `invalid client` -- reads as a broken proxy rather than as two empty values. The
chart's rule is to validate values and fail the render, never the pod.
*/}}
{{- define "acs-cymru.validateStudioRoute" -}}
{{- if and .Values.ingress.enabled (eq (index .Values.ingress.routes "studio") true) -}}
{{- if or (not .Values.secrets.studioOAuthClientSecret) (not .Values.secrets.studioProxyHmacSecret) -}}
{{- fail "\n\nacs-cymru: ingress.routes.studio is true but Studio's door has no credentials.\n\nThe route publishes the gateway's studio listener, which runs an OAuth flow against this stack's own\nGoTrue and admits `Administrator` only. Without both values below the flow has no registered client\nand no cookie key, so every request to studio.<publicBaseDomain> ends at a login that cannot\ncomplete -- which looks like a broken proxy rather than like an unset value.\n\nSet both:\n  secrets.studioOAuthClientSecret   (also hashed into auth.oauth_clients by migration 0081)\n  secrets.studioProxyHmacSecret     (signs the session cookie; nothing else reads it)\n\nOr leave ingress.routes.studio at its default of false and reach the console with a port-forward.\n" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
A Secure-cookie login published over plain http on a host a browser will not keep the cookie for.

The gateway's studio and gitea listeners sign in through Envoy's oauth2 filter, which writes every
cookie it uses (nonce, code verifier, HMAC, bearer) with the Secure attribute. A browser keeps a
Secure cookie only on an https origin or on localhost / *.localhost, so on any other http host the
authorization round trip returns to a callback holding no state, and Envoy answers 401 `CSRF token
validation failed`. The dashboard, Grafana and Node-RED are unaffected: their sessions are their
own. Nothing crashes and no pod is unhealthy; the two doors never open.

The URL is judged, not global.scheme: a publicUrls.* override carries its own scheme.
*/}}
{{- define "acs-cymru.validateSecureCookieRoutes" -}}
{{- if .Values.ingress.enabled -}}
{{- range (include "acs-cymru.ingressRoutes" . | fromYamlArray) -}}
{{- if and (or (eq .name "studio") (eq .name "gitea")) (ne (index $.Values.ingress.routes .name) false) -}}
{{- $url := include (printf "acs-cymru.%sUrl" .name) $ -}}
{{- if and (hasPrefix "http://" $url) (not (or (eq .host "localhost") (hasSuffix ".localhost" .host))) -}}
{{- fail (printf "\n\nacs-cymru: ingress.routes.%s is published at %s, where its login cannot complete.\n\nThe %s listener signs in through Envoy's oauth2 filter, which sets every cookie it uses with the\nSecure attribute. A browser keeps those only on an https origin or on localhost / *.localhost; on\nthis host the callback arrives holding no state and answers 401 `CSRF token validation failed`.\nNothing crashes -- the door never opens.\n\nOne of:\n  global.scheme: https with ingress.tls.enabled (or a TLS terminator in front of the ingress)\n  a *.localhost domain on a single machine, e.g. global.publicBaseDomain: localhost\n  ingress.routes.%s: false, and reach it with a port-forward\n" .name $url .name .name) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "acs-cymru.validate" -}}
{{- include "acs-cymru.validateSecrets" . -}}
{{- include "acs-cymru.validateStudioRoute" . -}}
{{- include "acs-cymru.validateMqttPrincipals" . -}}
{{- include "acs-cymru.validateRealtime" . -}}
{{- include "acs-cymru.validateRealtimeServiceName" . -}}
{{- include "acs-cymru.validatePublicUrls" . -}}
{{- include "acs-cymru.validateScheme" . -}}
{{- include "acs-cymru.validateIngress" . -}}
{{- include "acs-cymru.validateSecureCookieRoutes" . -}}
{{- include "acs-cymru.validateBrokerTls" . -}}
{{- include "acs-cymru.validateAutoscaling" . -}}
{{- include "acs-cymru.validateCapacity" . -}}
{{- end -}}

{{/*
Broker client transport, shared by the ingestion daemon, i3X, Node-RED, playback and the e2e
validator.

DEFINED ONCE because they must agree. They read the SAME environment variable names --
ingestion.py's `configure_mqtt_tls()`, i3x_service.py, playback_worker.py, validate.py and
node-red-init.mjs's transport reconciliation were written against one contract deliberately -- so a
port set for one and not another is a class of mistake worth making unrepresentable. Same reasoning
as the NetworkPolicy edge list.
*/}}
{{- define "acs-cymru.brokerClientEnv" -}}
{{- $tls := .Values.mosquitto.tls -}}
- name: MQTT_HOST
  value: mosquitto
{{- if and $tls.enabled $tls.internalClients }}
- name: MQTT_PORT
  value: "8883"
- name: MQTT_TLS_ENABLED
  value: "true"
{{- /* Projected from the broker's certificate Secret -- see acs-cymru.brokerClientCaVolume for
       why only ca.crt is mounted and not the whole Secret. */}}
- name: MQTT_TLS_CA_FILE
  value: /etc/acs-cymru/broker-ca/ca.crt
{{- else }}
- name: MQTT_PORT
  value: "1883"
{{- end }}
{{- end -}}

{{/*
The CA-only projection of the broker certificate Secret.

ONLY `ca.crt` IS PROJECTED, AND THAT IS THE POINT. `mosquitto-tls` is a kubernetes.io/tls Secret, so
it holds `tls.key` -- THE BROKER'S PRIVATE KEY -- alongside the CA certificate. Mounting the whole
Secret into every client pod would hand each of them the key that lets anything
impersonate the broker, to verify a certificate they only need the public CA for.

`items` restricts the projection at the kubelet, so the key is never written into either pod's
filesystem. 0444: a CA certificate is public by nature and every process in the container may read
it; it is the absence of tls.key that matters here, not the mode.
*/}}
{{- define "acs-cymru.brokerClientCaVolume" -}}
- name: broker-ca
  secret:
    secretName: {{ .Values.mosquitto.tls.secretName }}
    defaultMode: 0444
    items:
      - key: ca.crt
        path: ca.crt
{{- end -}}

{{- define "acs-cymru.brokerClientCaMount" -}}
- name: broker-ca
  mountPath: /etc/acs-cymru/broker-ca
  readOnly: true
{{- end -}}

{{/* ---------------------------------------------------------------------------------------- */}}
{{/* 3. Connection strings                                                                      */}}
{{/*                                                                                            */}}
{{/* Built here rather than per service so the host, port and password are written once. Every   */}}
{{/* one targets the IN-CLUSTER Service name and the STANDARD port -- never a published port.    */}}
{{/* ---------------------------------------------------------------------------------------- */}}

{{/*
M2. TimescaleDB is reached at `timescaledb:5432`, NEVER the host-published 5433.

5433 exists only to keep the dev loop's forwarded port off a developer's local PostgreSQL; the
server listens on 5432. The postgres_fdw foreign server in 0001_baseline_schema.sql is the reader
that matters here -- a wrong port there fails as a relation-level error from PostgREST rather than
as a connection error, so it reads as a schema fault. `helm test` (M6) queries the foreign table to
pin it.
*/}}
{{- define "acs-cymru.timescale.host" -}}timescaledb{{- end -}}
{{- define "acs-cymru.timescale.port" -}}5432{{- end -}}

{{- define "acs-cymru.supabaseDb.host" -}}supabase-db{{- end -}}
{{- define "acs-cymru.supabaseDb.port" -}}5432{{- end -}}

{{/* The gateway, as reached from INSIDE the cluster. The browser-facing address is publicUrls.supabase. */}}
{{- define "acs-cymru.supabase.internalUrl" -}}http://supabase-kong:8000{{- end -}}

{{/* ---------------------------------------------------------------------------------------- */}}
{{/* TLS to the databases (`postgresTls`)                                                     */}}
{{/*                                                                                            */}}
{{/* Both databases are issued by the same issuer, so one CA verifies either. Clients project    */}}
{{/* `ca.crt` alone from the Supabase database's Secret (the historian's when Supabase is off), */}}
{{/* for the reason the broker's projection gives: the Secret also holds the server's key.       */}}
{{/* ---------------------------------------------------------------------------------------- */}}

{{- define "acs-cymru.dbTlsSecretName" -}}{{ printf "%s-tls" . }}{{- end -}}
{{- define "acs-cymru.dbCaSecretName" -}}
{{- ternary "supabase-db-tls" "timescaledb-tls" .Values.supabaseDb.enabled -}}
{{- end -}}
{{- define "acs-cymru.dbCaPath" -}}/etc/acs-cymru/db-ca/ca.crt{{- end -}}

{{/* Each of these renders nothing while TLS is off, so a caller adds them to an existing list
     unconditionally and only wraps a list that would otherwise be empty. */}}
{{- define "acs-cymru.dbClientCaVolume" -}}
{{- if .Values.postgresTls.enabled }}
- name: db-ca
  secret:
    secretName: {{ include "acs-cymru.dbCaSecretName" . }}
    defaultMode: 0444
    items:
      - key: ca.crt
        path: ca.crt
{{- end }}
{{- end -}}

{{- define "acs-cymru.dbClientCaMount" -}}
{{- if .Values.postgresTls.enabled }}
- name: db-ca
  mountPath: /etc/acs-cymru/db-ca
  readOnly: true
{{- end }}
{{- end -}}

{{/* libpq's own variables. psql, pg_dump, psycopg2 and PostgREST all read them, so no client
     needs a flag of its own; absent, libpq negotiates nothing and the server offers nothing. */}}
{{- define "acs-cymru.dbClientTlsEnv" -}}
{{- if .Values.postgresTls.enabled }}
- name: PGSSLMODE
  value: verify-full
- name: PGSSLROOTCERT
  value: {{ include "acs-cymru.dbCaPath" . }}
{{- end }}
{{- end -}}

{{/* The DSN tail for the clients that spell the mode in their URL (GoTrue, PostgREST). */}}
{{- define "acs-cymru.dsnSslParams" -}}
{{- if .Values.postgresTls.enabled -}}
sslmode=verify-full&sslrootcert={{ include "acs-cymru.dbCaPath" . }}
{{- else -}}
sslmode=disable
{{- end -}}
{{- end -}}

{{/* The CA as PEM in an environment variable, which is how storage-api and postgres-meta take
     it. Public material, so the variable is fine. Usage: (dict "ctx" . "name" "DATABASE_SSL_ROOT_CERT") */}}
{{- define "acs-cymru.dbCaPemEnv" -}}
{{- if .ctx.Values.postgresTls.enabled }}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ include "acs-cymru.dbCaSecretName" .ctx }}
      key: ca.crt
{{- end }}
{{- end -}}

{{/*
The certificate reload sidecar for a database pod. cert-manager renews the leaf in place and
nothing restarts a StatefulSet for it; Postgres re-reads its certificate files on a reload, so
this watches the mounted certificate and asks for one over loopback, which pg_hba trusts.
Usage: (dict "ctx" . "image" "<repo:tag>" "pullPolicy" "IfNotPresent" "user" "postgres" "db" "postgres")
*/}}
{{- define "acs-cymru.dbCertificateReload" -}}
- name: certificate-reload
  image: {{ .image | quote }}
  imagePullPolicy: {{ .pullPolicy }}
  command:
    - /bin/sh
    - -c
    - |
      lastcert=$(md5sum < /etc/acs-cymru/postgres/tls/tls.crt)
      while :; do
        sleep {{ .ctx.Values.postgresTls.watchIntervalSeconds }}
        nowcert=$(md5sum < /etc/acs-cymru/postgres/tls/tls.crt)
        [ "$nowcert" = "$lastcert" ] && continue
        lastcert="$nowcert"
        echo "database certificate changed (renewal); reloading"
        if psql -h 127.0.0.1 -U {{ .user }} -d {{ .db }} -tAc 'SELECT pg_reload_conf()' >/dev/null; then
          echo "reloaded; the renewed certificate is served"
        else
          echo "reload failed; the server keeps the old certificate until its next reload" >&2
        fi
      done
  volumeMounts:
    - name: tls
      mountPath: /etc/acs-cymru/postgres/tls
      readOnly: true
  resources:
    requests: { cpu: 10m, memory: 16Mi }
    limits: { memory: 64Mi }
{{- end -}}

{{/* The server-side settings, as `-c` flags appended to each image's own command. */}}
{{- define "acs-cymru.dbTlsServerArgs" -}}
- -c
- ssl=on
- -c
- ssl_cert_file=/etc/acs-cymru/postgres/tls/tls.crt
- -c
- ssl_key_file=/etc/acs-cymru/postgres/tls/tls.key
- -c
- hba_file=/etc/acs-cymru/postgres/pg_hba.conf
{{- end -}}

{{/* The server-side mounts and volumes. `tls` is the cert-manager Secret, 0440 so the key is
     group-readable by the database user (fsGroup) and world-readable by nobody; Postgres
     accepts a root-owned key at that mode. `hba` is the chart's pg_hba.conf. */}}
{{- define "acs-cymru.dbTlsServerMounts" -}}
- name: tls
  mountPath: /etc/acs-cymru/postgres/tls
  readOnly: true
- name: hba
  mountPath: /etc/acs-cymru/postgres/pg_hba.conf
  subPath: {{ printf "%s.pg_hba.conf" .db }}
  readOnly: true
{{- end -}}

{{- define "acs-cymru.dbTlsServerVolumes" -}}
- name: tls
  secret:
    secretName: {{ include "acs-cymru.dbTlsSecretName" .db }}
    defaultMode: 0440
- name: hba
  configMap:
    name: {{ printf "%s-postgres-tls" (include "acs-cymru.fullname" .ctx) }}
{{- end -}}

{{/*
DSN builder. Usage:
  {{ include "acs-cymru.dsn" (dict "user" "authenticator" "password" $pw "host" "supabase-db" "port" 5432 "db" "postgres" "params" (include "acs-cymru.dsnSslParams" .)) }}
The password is urlquery-escaped: a generated password containing @ or / silently truncates the
DSN at the wrong character and the failure reads as a bad hostname.
*/}}
{{- define "acs-cymru.dsn" -}}
{{- $params := .params | default "" -}}
{{- printf "postgres://%s:%s@%s:%v/%s%s" .user (urlquery .password) .host .port .db (ternary (printf "?%s" $params) "" (ne $params "")) -}}
{{- end -}}

{{/* ---------------------------------------------------------------------------------------- */}}
{{/* 4. Environment blocks                                                                      */}}
{{/* ---------------------------------------------------------------------------------------- */}}

{{/*
Browser-facing URLs. Each falls back to <sub>.<publicBaseDomain> so a deployment sets one value.

THESE ARE NEVER THE IN-CLUSTER ADDRESS. The distinction is the single most repeated hazard in this
stack: auth_url is followed by the BROWSER, token_url and userinfo are called by the CONTAINER, and
using one for both fails in a way that names neither. In-cluster URLs are not configurable at all
-- the Service names are the ones every in-cluster URL carries, so they are constants.
*/}}
{{- define "acs-cymru.publicUrl" -}}
{{- $explicit := index .ctx.Values.publicUrls .key -}}
{{- if $explicit -}}
{{- $explicit | trimSuffix "/" -}}
{{- else if .ctx.Values.global.publicBaseDomain -}}
{{- printf "%s://%s.%s" .ctx.Values.global.scheme .sub .ctx.Values.global.publicBaseDomain -}}
{{- end -}}
{{- end -}}

{{- define "acs-cymru.frontendUrl" -}}{{ include "acs-cymru.publicUrl" (dict "ctx" . "key" "frontend" "sub" "app") }}{{- end -}}
{{- define "acs-cymru.supabaseUrl" -}}{{ include "acs-cymru.publicUrl" (dict "ctx" . "key" "supabase" "sub" "api") }}{{- end -}}
{{- define "acs-cymru.grafanaUrl" -}}{{ include "acs-cymru.publicUrl" (dict "ctx" . "key" "grafana" "sub" "grafana") }}{{- end -}}
{{- define "acs-cymru.noderedUrl" -}}{{ include "acs-cymru.publicUrl" (dict "ctx" . "key" "nodered" "sub" "nodered") }}{{- end -}}
{{- define "acs-cymru.studioUrl" -}}{{ include "acs-cymru.publicUrl" (dict "ctx" . "key" "studio" "sub" "studio") }}{{- end -}}
{{- define "acs-cymru.docsUrl" -}}{{ include "acs-cymru.publicUrl" (dict "ctx" . "key" "docs" "sub" "docs") }}{{- end -}}
{{- define "acs-cymru.mqttUrl" -}}{{ include "acs-cymru.publicUrl" (dict "ctx" . "key" "mqtt" "sub" "mqtt") }}{{- end -}}

{{/*
The browser origins the gateway echoes an Access-Control-Allow-Origin for -- a JSON array,
substituted into `__CORS_ORIGINS__` in files/envoy/envoy.yaml.

WHY THIS IS DERIVED AND NOT CONFIGURED. It is the stack's ONLY statement of origin policy: the
edge functions carry no Access-Control-Allow-Origin of their own on purpose (see
supabase/functions/_shared/cors.ts), since the gateway is the only layer that sees a request
before deciding to route it. So an origin that is wrong here has nothing behind it to compensate.

The two browser-facing origins are the dashboard and Swagger UI, and both already have a helper
because the Ingress needs their hostnames. Deriving from those helpers is what makes it impossible
for the origin list to name a host the chart does not serve, or to miss one that it does -- the
same single-source argument values.yaml makes for publicUrls.grafana, and the failure this closes
is worse: a four-origin localhost literal shipped here for as long as Kubernetes did, so on a real
cluster the dashboard authenticated and then could not read a single response. Nothing caught it,
because `curl` sends no Origin and does not enforce the answer.

`corsExtraOrigins` is for the cases the chart cannot know: a reverse proxy in front of the Ingress,
a tunnel, a second hostname on the same deployment. Appended rather than replacing, so adding one
cannot silently drop the dashboard's own origin.

EMPTY IS REFUSED. A data-tier install with no publicBaseDomain and no publicUrls has no browser
origin to name, and rendering `origins: []` produces a gateway that starts and refuses every
browser request -- the exact failure this helper exists to end, arrived at by a different route.
*/}}
{{- define "acs-cymru.corsOrigins" -}}
{{- $origins := list -}}
{{- $frontend := include "acs-cymru.frontendUrl" . -}}
{{- if $frontend -}}{{- $origins = append $origins $frontend -}}{{- end -}}
{{- $docs := include "acs-cymru.docsUrl" . -}}
{{- if $docs -}}{{- $origins = append $origins $docs -}}{{- end -}}
{{- range .Values.global.corsExtraOrigins -}}
{{- $origins = append $origins (. | trimSuffix "/") -}}
{{- end -}}
{{/*
REFUSED ONLY WHEN THERE IS SOMETHING TO REFUSE FOR.

An install with no public surface at all -- no publicBaseDomain and no publicUrls -- has no
browser to serve and no origin to name, and an empty list is the honest answer there. It is also
already refused, more specifically, by the `no browser-facing URL` and `no route resolved a
hostname` guards. Failing here as well would MASK them: this helper is reached first, so a
missing publicBaseDomain reported the CORS symptom instead of the cause. (Caught by the chart
guard-rail suite in ci.yml, which asserts each guard's own message.)

The narrow case that IS this helper's to catch: publicUrls.supabase set, so the API is genuinely
browser-facing, while nothing names an origin allowed to call it.
*/}}
{{- if and (not $origins) (include "acs-cymru.supabaseUrl" .) -}}
{{- fail "\n\nacs-cymru: the gateway would be given an EMPTY browser-origin list.\n\npublicUrls.supabase names a browser-facing API, but no origin could be derived for the\ndashboard or for Swagger UI -- so the gateway would start cleanly and then refuse every browser\nrequest to it, returning 200 with no Access-Control-Allow-Origin. That presents as a\ndashboard which signs in and then shows empty tables, with nothing failing anywhere you\nwould think to look.\n\nSet global.publicBaseDomain, or publicUrls.frontend / publicUrls.docs, or\nglobal.corsExtraOrigins if this deployment is reached only through a proxy whose hostname\nthe chart cannot derive.\n" -}}
{{- end -}}
{{- $origins | uniq | toJson -}}
{{- end -}}
{{/*
The i3X server's browser-facing URL.

Derived here like every other public URL rather than written as a literal, because it has more than
one consumer: the Ingress rule, NOTES.txt, and -- for anyone pointing the CESMII conformance suite
or the MCP server at this deployment -- the value of `I3X_BASE_URL`. One definition means an ingress
hostname cannot disagree with what is documented as the endpoint.
*/}}
{{- define "acs-cymru.i3xUrl" -}}{{ include "acs-cymru.publicUrl" (dict "ctx" . "key" "i3x" "sub" "i3x") }}{{- end -}}

{{/*
The forge's browser-facing URL.

Derived like every other public URL rather than written as a literal, and it has a consumer the
others do not: Gitea's own `ROOT_URL`, which is what a repository page prints as the clone command.
One definition means the address an engineer copies cannot disagree with the address the Ingress
actually routes -- a mismatch there is discovered on an appliance, as a name that will not resolve.
*/}}
{{- define "acs-cymru.giteaUrl" -}}{{ include "acs-cymru.publicUrl" (dict "ctx" . "key" "gitea" "sub" "git") }}{{- end -}}

{{/*
Host only, for an Ingress rule -- the scheme and any path stripped off.

Ingress `host` is a DNS name and rejects a scheme; feeding it a URL produces a rule that matches
nothing, and the Ingress is accepted, so it fails as a 404 from the controller's default backend
rather than as a validation error. The URL helpers above are the single source, so the host and the
URL a service is told to advertise can never disagree.
*/}}
{{- define "acs-cymru.hostOf" -}}
{{- $url := include (printf "acs-cymru.%sUrl" .name) .ctx -}}
{{- if $url -}}
{{- regexReplaceAll "^[a-z]+://" $url "" | splitList "/" | first -}}
{{- end -}}
{{- end -}}

{{/*
Every ingress route in one place: subdomain, backend Service, port, and whether it is deployed.

Built here rather than in ingress.yaml so the ingress and anything else that needs to reason about
the public surface (NOTES.txt, and the NetworkPolicies) read one definition.
*/}}
{{- define "acs-cymru.ingressRoutes" -}}
{{- $routes := list -}}
{{- if .Values.frontend.enabled -}}
{{- $routes = append $routes (dict "name" "frontend" "host" (include "acs-cymru.hostOf" (dict "ctx" . "name" "frontend")) "service" "frontend" "port" 3000) -}}
{{- end -}}
{{- if .Values.supabaseEnvoy.enabled -}}
{{- $routes = append $routes (dict "name" "supabase" "host" (include "acs-cymru.hostOf" (dict "ctx" . "name" "supabase")) "service" .Values.supabaseEnvoy.serviceName "port" 8000) -}}
{{- end -}}
{{- if .Values.nodeRed.enabled -}}
{{- $routes = append $routes (dict "name" "nodered" "host" (include "acs-cymru.hostOf" (dict "ctx" . "name" "nodered")) "service" "node-red" "port" 1880) -}}
{{- end -}}
{{- if .Values.grafana.enabled -}}
{{- $routes = append $routes (dict "name" "grafana" "host" (include "acs-cymru.hostOf" (dict "ctx" . "name" "grafana")) "service" "grafana" "port" 3000) -}}
{{- end -}}
{{/* STUDIO IS PUBLISHED THROUGH THE GATEWAY, NEVER DIRECTLY, and this line is the whole control.
     `supabase-studio:3000` is a database console with no login, no roles and no session, running
     as the database owner -- naming it here would put that on a public hostname. The gateway's
     `studio` listener on 8001 is the same console behind an OAuth flow and an `Administrator`
     check, so the route names the GATEWAY Service and the Studio Service is reachable in-cluster
     only.

     Gated on the gateway AS WELL as on Studio existing: without the gateway this route has no
     backend to name and is correctly absent rather than pointed somewhere unauthenticated. */}}
{{- if and .Values.supabaseStudio.enabled .Values.supabaseEnvoy.enabled -}}
{{- $routes = append $routes (dict "name" "studio" "host" (include "acs-cymru.hostOf" (dict "ctx" . "name" "studio")) "service" .Values.supabaseEnvoy.serviceName "port" 8001) -}}
{{- end -}}
{{- if .Values.swaggerUi.enabled -}}
{{- $routes = append $routes (dict "name" "docs" "host" (include "acs-cymru.hostOf" (dict "ctx" . "name" "docs")) "service" "swagger-ui" "port" 8080) -}}
{{- end -}}
{{- if .Values.i3xService.enabled -}}
{{/* The i3X server is browser- and client-facing: the MCP server, the i3X Explorer and any
     conformance run all reach it over HTTP from outside the cluster, so it needs a route of its
     own. `GET /info` is unauthenticated by spec, so this hostname exposes a capabilities document
     to anyone who can reach the ingress -- which is intended (it is the health check) and is why
     nothing about the address space is in it. */}}
{{- $routes = append $routes (dict "name" "i3x" "host" (include "acs-cymru.hostOf" (dict "ctx" . "name" "i3x")) "service" "i3x-service" "port" 8090) -}}
{{- end -}}
{{- if and .Values.gitea.enabled .Values.supabaseEnvoy.enabled -}}
{{/* THE WEB HALF OF THE FORGE ONLY, AND THROUGH THE GATEWAY, NEVER DIRECTLY. Git over SSH is TCP
     and cannot ride an HTTP Ingress at all -- that is `gitea-external`'s job, exactly as raw MQTT
     is mosquitto-external's. Naming this route is therefore not enough to make an appliance able
     to clone, which is the thing that would otherwise be discovered on a gateway rather than here.

     THE BACKEND IS THE GATEWAY'S `forge` LISTENER (8002) AND THIS LINE IS THE WHOLE CONTROL, as
     Studio's is. Gitea runs with reverse-proxy authentication on, which signs in whoever the
     X-WEBAUTH-USER header names -- from any peer, measured. A route naming `gitea:3000` would put
     that on a public hostname, where a request from the internet chooses its own identity. Gated
     on the gateway for the same reason as Studio's: without it the forge's web UI is correctly
     absent rather than published bare. */}}
{{- $routes = append $routes (dict "name" "gitea" "host" (include "acs-cymru.hostOf" (dict "ctx" . "name" "gitea")) "service" .Values.supabaseEnvoy.serviceName "port" 8002) -}}
{{- end -}}
{{- if .Values.mosquitto.enabled -}}
{{/* MQTT over WEBSOCKETS only -- port 9001. Raw MQTT on 1883 is TCP and cannot ride an HTTP
     Ingress at all; that is what the mosquitto-external LoadBalancer is for. */}}
{{- $routes = append $routes (dict "name" "mqtt" "host" (include "acs-cymru.hostOf" (dict "ctx" . "name" "mqtt")) "service" "mosquitto" "port" 9001) -}}
{{- end -}}
{{- toYaml $routes -}}
{{- end -}}

{{/*
Wait-for initContainer. Usage:
  (dict "ctx" $ "name" "wait-for-db" "command" "<shell test>" "describe" "supabase-db")

WHY THIS EXISTS. Kubernetes has no `depends_on`. A Deployment whose dependency is not up does not
wait -- it starts, fails, and CrashLoopBackOffs with an error about the dependency rather than
about the ordering, which is a slower way to learn the same thing. These loops make the ordering
explicit and make the pod sit in Init: with a legible reason.

The loop is bounded. An unbounded wait produces a pod that is Init: forever with no failure to
alert on -- worse than a clean failure, because nothing surfaces it.

`command` AND `describe` ARE REQUIRED, and the render fails without them rather than emitting a
container that cannot work. A caller that omitted them -- i3x-service passed `port`, which this
helper does not take -- produced `until ; do`, which is valid YAML holding a shell syntax error.
So `helm lint`, `helm template` and kubeconform all passed, the manifest installed cleanly, and the
only symptom was one Deployment in Init:CrashLoopBackOff with `/bin/sh: syntax error: unexpected
";"` buried in an initContainer's log. That is the chart's stated rule -- validate values and fail
the render, never the pod -- applied to its own helpers.
*/}}
{{- define "acs-cymru.waitFor" -}}
{{- if not .command }}{{- fail (printf "acs-cymru.waitFor(%s): `command` is required. It is the shell test the until-loop runs; without it the container renders as `until ; do` and dies with a shell syntax error at runtime instead of failing here." (.name | default "<unnamed>")) }}{{- end }}
{{- if not .describe }}{{- fail (printf "acs-cymru.waitFor(%s): `describe` is required. It is what the pod prints while waiting and on timeout, and it is the only thing that makes an Init: pod legible." (.name | default "<unnamed>")) }}{{- end }}
- name: {{ .name | required "acs-cymru.waitFor: `name` is required (it names the initContainer in kubectl output)." }}
  image: {{ .image | default "busybox:1.36" }}
  imagePullPolicy: IfNotPresent
  {{- /* Optional `env`, for a probe that needs a credential -- a gated gateway route, say.
         Passed as rendered YAML so the caller composes it with acs-cymru.secretEnv and no secret
         value ever reaches a command line, where `kubectl describe` would show it. */ -}}
  {{- with .env }}
  env:
    {{- . | nindent 4 }}
  {{- end }}
  command:
    - /bin/sh
    - -c
    - |
      deadline=$(( $(date +%s) + {{ .ctx.Values.initJobs.waitTimeout }} ))
      until {{ .command }}; do
        if [ "$(date +%s)" -ge "$deadline" ]; then
          echo "timed out after {{ .ctx.Values.initJobs.waitTimeout }}s waiting for {{ .describe }}" >&2
          exit 1
        fi
        echo "waiting for {{ .describe }} ..."
        sleep 3
      done
      echo "{{ .describe }} is ready"
{{- end -}}

{{/*
Wait for a Postgres to accept a QUERY, not merely a connection.

`pg_isready` is not enough against supabase/postgres: it answers during the image's own bootstrap
while the server still refuses queries, so a migration Job gated on it starts too early and fails
part-way through -- leaving a half-applied schema, which is the worst outcome available here.

OPTIONAL `query` LETS A CALLER WAIT FOR A SCHEMA RATHER THAN A SERVER, which is a different and
usually stronger precondition. `psql -c` exits non-zero on a missing relation exactly as it does on
a refused connection, so one probe covers "the database is down" and "the migrations have not run
yet" without distinguishing them -- and the caller does not need to, because the answer to both is
"keep waiting". Optional `describe` names what is being waited FOR in the log and the timeout
message; without it the message names only the host, which is the least useful half.
*/}}
{{- define "acs-cymru.waitForPostgres" -}}
- name: {{ .name }}
  image: "{{ .ctx.Values.supabaseDb.image.repository }}:{{ .ctx.Values.supabaseDb.image.tag }}"
  imagePullPolicy: {{ .ctx.Values.supabaseDb.image.pullPolicy }}
  env:
    - name: PGPASSWORD
      valueFrom:
        secretKeyRef:
          name: {{ include "acs-cymru.secretName" .ctx }}
          key: {{ .passwordKey }}
  command:
    - /bin/sh
    - -c
    - |
      deadline=$(( $(date +%s) + {{ .ctx.Values.initJobs.waitTimeout }} ))
      until psql -h {{ .host }} -p {{ .port }} -U {{ .user }} -d {{ .db }} -c {{ .query | default "SELECT 1;" | quote }} >/dev/null 2>&1; do
        if [ "$(date +%s)" -ge "$deadline" ]; then
          echo "timed out after {{ .ctx.Values.initJobs.waitTimeout }}s waiting for {{ .describe | default .host }}" >&2
          exit 1
        fi
        echo "waiting for {{ .describe | default (printf "%s to accept queries" .host) }} ..."
        sleep 3
      done
      echo "{{ .describe | default (printf "%s is accepting queries" .host) }} — ready"
{{- end -}}

{{/* Pull one key from the chart's Secret as an env var. */}}
{{- define "acs-cymru.secretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ .secretName }}
      key: {{ .key }}
{{- end -}}

{{/*
The same, but `optional: true` -- for a key the Secret is allowed NOT to carry.

WHY A SECOND HELPER RATHER THAN A FLAG ON THE ONE ABOVE. The default must stay fail-closed. A
required secretKeyRef stops the pod from starting when the key is absent, which is the right
outcome for every credential this chart has ever passed: a container that boots without its
credential fails later, further away, and in a way that reads as a broken upstream.

For a key an install may legitimately not hold: absent means empty, and the consumer treats
empty as "not configured".
*/}}
{{- define "acs-cymru.optionalSecretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ .secretName }}
      key: {{ .key }}
      optional: true
{{- end -}}

{{/*
The MQTT principals the chart itself provisions, as env, for the broker's assemble-config
initContainer, which writes them into the Dynamic Security document on every start. The set must
match PLATFORM_PRINCIPALS in scripts/lib/mosquitto-dynsec.mjs, which is what reads these names.

An EMPTY password skips that account rather than writing an empty one. `mqttValidatorPassword` is
the case that matters: the validator is a fixture, so a production install leaves it unset and
should simply not have the account. Gateway accounts are not here at all: they are issued against a
row that already exists, through the credential service.

Consumers (ingestion, i3x, node-red, the validator Job) each take only THEIR OWN pair, so this is
deliberately not used there: the point of the split is that no workload holds another's credential.
*/}}
{{- define "acs-cymru.mqttPrincipals" -}}
INGESTION I3X VALIDATOR MONITOR
{{- end -}}

{{- define "acs-cymru.mqttPrincipalEnv" -}}
{{- $secretName := include "acs-cymru.secretName" . -}}
{{- range $p := splitList " " (include "acs-cymru.mqttPrincipals" .) }}
{{ include "acs-cymru.secretEnv" (dict "name" (printf "MQTT_%s_USER" $p) "secretName" $secretName "key" (printf "MQTT_%s_USER" $p)) }}
{{ include "acs-cymru.secretEnv" (dict "name" (printf "MQTT_%s_PASSWORD" $p) "secretName" $secretName "key" (printf "MQTT_%s_PASSWORD" $p)) }}
{{- end }}
{{- end -}}

{{/*
Node-RED authentication environment — one definition included in two places, and load-bearing
for that reason.

BOTH the node-red container AND its init container must receive this block, identically.
scripts/node-red-init.mjs's settingsAreCorrect() EVALUATES the settings.js it wrote, and
settings.js resolves every one of these from process.env at load time. A value present when the
file was written and absent when it is read makes the settings look wrong on every boot and get
rewritten forever -- silently, because an unloadable settings.js is already handled as "replace
it". One definition, included twice, is what prevents that.

Defined here, with the helpers, so the anchor's guarantee is established rather
than bolted on beside the Deployment that happens to need it first.
*/}}
{{- define "acs-cymru.noderedAuthEnv" -}}
{{- $secretName := include "acs-cymru.secretName" . -}}
{{- $nodered := .Values.publicUrls.nodered | default (printf "%s://nodered.%s" .Values.global.scheme .Values.global.publicBaseDomain) -}}
{{- $supabase := .Values.publicUrls.supabase | default (printf "%s://api.%s" .Values.global.scheme .Values.global.publicBaseDomain) -}}
{{ include "acs-cymru.secretEnv" (dict "name" "NODERED_CREDENTIAL_SECRET" "secretName" $secretName "key" "NODERED_CREDENTIAL_SECRET") }}
{{ include "acs-cymru.secretEnv" (dict "name" "NODERED_OAUTH_CLIENT_SECRET" "secretName" $secretName "key" "NODERED_OAUTH_CLIENT_SECRET") }}
{{ include "acs-cymru.secretEnv" (dict "name" "NODERED_WEBHOOK_JWT_SECRET" "secretName" $secretName "key" "NODERED_WEBHOOK_JWT_SECRET") }}
{{ include "acs-cymru.secretEnv" (dict "name" "NODERED_ADMIN_TOKEN" "secretName" $secretName "key" "NODERED_ADMIN_TOKEN") }}
{{ include "acs-cymru.secretEnv" (dict "name" "SUPABASE_JWT_SECRET" "secretName" $secretName "key" "SUPABASE_JWT_SECRET") }}
{{ include "acs-cymru.secretEnv" (dict "name" "SUPABASE_PUBLISHABLE_KEY" "secretName" $secretName "key" "SUPABASE_PUBLISHABLE_KEY") }}
- name: NODERED_OAUTH_CLIENT_ID
  value: {{ .Values.nodeRed.oauthClientId | default "c0ffee00-0000-4000-8000-000000000002" | quote }}
{{/* auth_url is followed by the BROWSER, so it is the ingress address. token_url and userinfo are
     called by the CONTAINER, so they are in-cluster. Using one for both is the classic way this
     breaks -- a browser cannot resolve `supabase-kong`, and the container's 127.0.0.1 is itself. */}}
- name: NODERED_OAUTH_AUTH_URL
  value: {{ printf "%s/auth/v1/oauth/authorize" $supabase | quote }}
- name: NODERED_OAUTH_TOKEN_URL
  value: {{ printf "%s/auth/v1/oauth/token" (include "acs-cymru.supabase.internalUrl" .) | quote }}
- name: NODERED_USERINFO_URL
  value: {{ printf "%s/functions/v1/nodered-userinfo" (include "acs-cymru.supabase.internalUrl" .) | quote }}
{{/* Must match redirect_uris in auth.oauth_clients exactly, or /oauth/authorize answers
     "invalid redirect_uri". Both are built from publicUrls.nodered so they cannot drift. */}}
- name: NODERED_OAUTH_CALLBACK_URL
  value: {{ printf "%s/auth/strategy/callback" $nodered | quote }}
{{- end -}}

{{/*
The COMPONENT LABEL of whichever gateway is deployed.

NOT the Service name, and the distinction is the whole reason this exists. Promotion works by the
Envoy Service ADOPTING the name `supabase-kong`, so every consumer's URL keeps resolving -- but
NetworkPolicy and ServiceMonitor select POD LABELS, which the adopted name does not touch. Hard-
coding `supabase-kong` in those two leaves the policy denying every flow to the gateway and the
scrape selecting nothing, both of which present as the gateway being down rather than as a
mislabelled selector.

Returns `supabase-envoy` when Envoy is enabled, `supabase-kong` otherwise. Both enabled is refused
by templates/supabase/envoy.yaml when they would share a Service name; while they legitimately run
side by side, the NetworkPolicy follows Envoy because that is the one being proven.
*/}}
{{- define "acs-cymru.gatewayComponent" -}}
{{- if .Values.supabaseEnvoy.enabled -}}
supabase-envoy
{{- else -}}
supabase-kong
{{- end -}}
{{- end -}}

{{/*
Kubernetes quantity parsers. Helm has none, and the capacity guard below compares numbers that
arrive as strings from two unrelated places: `.Values` (written by hand, "100m", "256Mi") and the
node's `status.allocatable` (written by the kubelet, "16" or "15890m", almost always "…Ki").

Returned as integers -- millicores and bytes -- so the comparison never touches floating point.
*/}}
{{- define "acs-cymru.cpuMillis" -}}
{{- $v := . | toString -}}
{{- if hasSuffix "m" $v -}}
{{- trimSuffix "m" $v | float64 | int64 -}}
{{- else -}}
{{- mulf ($v | float64) 1000.0 | int64 -}}
{{- end -}}
{{- end -}}

{{- define "acs-cymru.memBytes" -}}
{{- $v := . | toString -}}
{{- $n := 0.0 -}}
{{- if hasSuffix "Ki" $v -}}{{- $n = mulf (trimSuffix "Ki" $v | float64) 1024.0 -}}
{{- else if hasSuffix "Mi" $v -}}{{- $n = mulf (trimSuffix "Mi" $v | float64) 1048576.0 -}}
{{- else if hasSuffix "Gi" $v -}}{{- $n = mulf (trimSuffix "Gi" $v | float64) 1073741824.0 -}}
{{- else if hasSuffix "Ti" $v -}}{{- $n = mulf (trimSuffix "Ti" $v | float64) 1099511627776.0 -}}
{{- else if hasSuffix "k" $v -}}{{- $n = mulf (trimSuffix "k" $v | float64) 1000.0 -}}
{{- else if hasSuffix "M" $v -}}{{- $n = mulf (trimSuffix "M" $v | float64) 1000000.0 -}}
{{- else if hasSuffix "G" $v -}}{{- $n = mulf (trimSuffix "G" $v | float64) 1000000000.0 -}}
{{- else -}}{{- $n = $v | float64 -}}
{{- end -}}
{{- $n | int64 -}}
{{- end -}}

{{/*
The chart's own scheduling floor: the sum of the `requests` it will ask for, as
"<millicores> <bytes>".

DERIVED FROM .Values RATHER THAN WRITTEN DOWN, for the reason validateAutoscaling derives its
allow-list: a floor that has to be edited in a second place when a component's requests change is
a floor that will be wrong, and wrong HIGH here refuses an install that would have worked.

Counted: every component that runs continuously and is enabled. NOT counted, deliberately --
  * e2e, backup, coldArchive: Jobs and CronJobs. They are transient, so including them would
    raise the floor above what the stack actually holds and refuse a node that can run it.
  * init containers: a pod's effective request is max(init, sum(containers)), and every init
    container here asks for less than the containers it precedes, so they never set the floor.
Each entry is `path.to.component` paired with its replica count, because the scheduler multiplies.
*/}}
{{- define "acs-cymru.requestFloor" -}}
{{- $cpu := 0 -}}
{{- $mem := 0 -}}
{{- $v := .Values -}}
{{- $units := list
  (dict "r" $v.timescaledb.resources "n" 1 "on" true)
  (dict "r" $v.supabaseDb.resources "n" 1 "on" true)
  (dict "r" $v.realtime.resources "n" (int $v.realtime.replicas) "on" $v.realtime.enabled)
  (dict "r" $v.supabaseAuth.resources "n" (int $v.supabaseAuth.replicas) "on" $v.supabaseAuth.enabled)
  (dict "r" $v.supabaseRest.resources "n" (int $v.supabaseRest.replicas) "on" $v.supabaseRest.enabled)
  (dict "r" $v.supabaseFunctions.resources "n" (int $v.supabaseFunctions.replicas) "on" $v.supabaseFunctions.enabled)
  (dict "r" $v.supabaseStorage.resources "n" (int $v.supabaseStorage.replicas) "on" $v.supabaseStorage.enabled)
  (dict "r" $v.supabaseMeta.resources "n" (int $v.supabaseMeta.replicas) "on" $v.supabaseMeta.enabled)
  (dict "r" $v.supabaseStudio.resources "n" (int $v.supabaseStudio.replicas) "on" $v.supabaseStudio.enabled)
  (dict "r" $v.swaggerUi.resources "n" (int $v.swaggerUi.replicas) "on" $v.swaggerUi.enabled)
  (dict "r" $v.mosquitto.resources "n" (int $v.mosquitto.replicas) "on" $v.mosquitto.enabled)
  (dict "r" $v.mosquitto.metrics.resources "n" (int $v.mosquitto.replicas) "on" $v.mosquitto.metrics.enabled)
  (dict "r" $v.gatewayCredential.resources "n" (int $v.mosquitto.replicas) "on" $v.gatewayCredential.enabled)
  (dict "r" $v.playback.resources "n" 1 "on" $v.playback.enabled)
  (dict "r" $v.ingestion.resources "n" 1 "on" $v.ingestion.enabled)
  (dict "r" $v.i3xService.resources "n" 1 "on" $v.i3xService.enabled)
  (dict "r" $v.nodeRed.resources "n" (int $v.nodeRed.replicas) "on" $v.nodeRed.enabled)
  (dict "r" $v.frontend.resources "n" (int $v.frontend.replicas) "on" $v.frontend.enabled)
  (dict "r" $v.grafana.resources "n" 1 "on" $v.grafana.enabled)
  (dict "r" $v.gitea.resources "n" 1 "on" $v.gitea.enabled)
  (dict "r" $v.backupService.resources "n" 1 "on" $v.backupService.enabled)
  (dict "r" $v.observability.prometheus.resources "n" 1 "on" $v.observability.enabled)
  (dict "r" $v.observability.loki.resources "n" 1 "on" $v.observability.enabled)
  (dict "r" $v.observability.alloy.resources "n" 1 "on" $v.observability.enabled)
-}}
{{- range $units -}}
{{- if .on -}}
{{- $req := (.r).requests | default dict -}}
{{- $n := .n | default 1 -}}
{{- if $req.cpu -}}
{{- $cpu = add $cpu (mul (include "acs-cymru.cpuMillis" $req.cpu | int64) $n) -}}
{{- end -}}
{{- if $req.memory -}}
{{- $mem = add $mem (mul (include "acs-cymru.memBytes" $req.memory | int64) $n) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- printf "%d %d" $cpu $mem -}}
{{- end -}}

{{/*
Refuses an install onto a cluster that cannot schedule the stack.

The failure this prevents is SILENT, which is why it is a refusal and not a note: when the
requests do not fit, `helm install` reports success, every workload is created, and the pods sit
Pending forever. Nothing appears in any container log, because no container ever starts. Only
`kubectl describe pod` names it, and only if you already suspect capacity.

FOUR THINGS IT DELIBERATELY DOES NOT DO:

  * It does not run on upgrade (`.Release.IsInstall`). A stack that is already running has already
    proved it fits; refusing its upgrade because a node is momentarily drained would be a
    self-inflicted outage.
  * It does not run when `lookup` returns nothing. That is the case under `helm template`, under
    `--dry-run`, and when the installing credential may not list nodes -- all three are legitimate,
    and none is evidence about capacity. `lookup` answers an empty map rather than failing, so this
    reads as "no opinion" and says nothing.
  * It does not exclude tainted nodes. Excluding them would be more accurate on a managed cluster
    whose control plane carries NoSchedule, but supabaseDb and timescaledb accept `tolerations`, so
    a tainted node may well be exactly where they are meant to land. Counting them over-states
    capacity, which errs towards letting an install proceed -- the same direction as every other
    choice here.
  * It does not multiply the DaemonSet by the node count. On a multi-node cluster the collector
    runs per node and the true floor is higher, but the allocatable being summed grows faster than
    the floor does, so the single-node figure is the conservative one.

Every one of those errs towards allowing an install that might be tight rather than refusing one
that would have worked. A false refusal is the expensive mistake here: the operator cannot tell it
from a broken chart.
*/}}
{{- define "acs-cymru.validateCapacity" -}}
{{/*
  `.Release.IsInstall` IS TESTED FIRST, AND `preflight` IS READ THROUGH A `default dict`, because
  `helm upgrade --reuse-values` replays the values stored with the PREVIOUS revision -- which, for
  every release installed before this guard existed, has no `preflight` key at all. Reading
  `.Values.preflight.capacityCheck` directly there is a nil-pointer panic that fails the upgrade at
  NOTES.txt with a message about interface{} and nothing about capacity. A new key in values.yaml
  is not present in an old release's stored values, and a guard is the worst place to learn it.
*/}}
{{- if .Release.IsInstall -}}
{{- if (.Values.preflight | default dict).capacityCheck -}}
{{- $nodes := (lookup "v1" "Node" "" "").items -}}
{{- if $nodes -}}
{{- $cpu := 0 -}}
{{- $mem := 0 -}}
{{- $counted := 0 -}}
{{- range $nodes -}}
{{- if not .spec.unschedulable -}}
{{- $counted = add1 $counted -}}
{{- $alloc := .status.allocatable -}}
{{- $cpu = add $cpu (include "acs-cymru.cpuMillis" $alloc.cpu | int64) -}}
{{- $mem = add $mem (include "acs-cymru.memBytes" $alloc.memory | int64) -}}
{{- end -}}
{{- end -}}
{{- $floor := splitList " " (include "acs-cymru.requestFloor" $) -}}
{{- $needCpu := index $floor 0 | int64 -}}
{{- $needMem := index $floor 1 | int64 -}}
{{- if or (lt $cpu $needCpu) (lt $mem $needMem) -}}
{{- $short := list -}}
{{- if lt $cpu $needCpu -}}
{{- $short = append $short (printf "CPU:    %dm allocatable, %dm requested" (int $cpu) (int $needCpu)) -}}
{{- end -}}
{{- if lt $mem $needMem -}}
{{- $short = append $short (printf "memory: %dMi allocatable, %dMi requested" (div (int $mem) 1048576) (div (int $needMem) 1048576)) -}}
{{- end -}}
{{- fail (printf "\n\nacs-cymru: this cluster cannot schedule the stack.\n\nAcross %d schedulable node(s):\n\n  %s\n\nThese are REQUESTS, not usage. A request is a reservation the scheduler must satisfy before it\nwill place a pod at all, so the shortfall does not make the stack slow -- it leaves pods Pending\nindefinitely, with nothing in any container log to say why, because no container starts. Refused\nhere rather than discovered there.\n\nThe documented minimum is 4 vCPU and 8 GiB on one node, measured rather than estimated:\ndeploy/k8s/README.md, Prerequisites -> Hardware.\n\nEither give the cluster more room, or lower what the chart asks for -- every component's\n`resources.requests` is a value, and this floor is derived from them, so reducing them reduces\nthis number too. Turning components off (grafana.enabled, gitea.enabled, observability.enabled)\nlowers it as well.\n\nTo install anyway and accept Pending pods:  --set preflight.capacityCheck=false\n" $counted (join "\n  " $short)) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
