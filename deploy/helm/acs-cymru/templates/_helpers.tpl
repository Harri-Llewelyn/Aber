{{/*
=================================================================================================
Shared template helpers.

This file is the chart's equivalent of docker-compose.yml's YAML anchors, and it exists for the
same reason `x-nodered-auth-env` does: several services must be handed the SAME value, and a
definition repeated per service drifts the first time one of them is edited alone.

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
oversight. Kubernetes Service names are kept IDENTICAL to the Compose service names, so in-cluster
DNS resolves `http://supabase-kong:8000`, `timescaledb:5432` and `mosquitto:1883` exactly as
Docker's embedded DNS does -- which means every compose-internal URL already in grafana.ini,
kong.yml, settings.js and the edge-function environment works here UNCHANGED.

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

{{/* ---------------------------------------------------------------------------------------- */}}
{{/* 2. Validation                                                                              */}}
{{/*                                                                                            */}}
{{/* Every check here FAILS THE RENDER. That is the point: each of these misconfigurations       */}}
{{/* otherwise produces a stack that reports healthy and then refuses every request, or a        */}}
{{/* CrashLoopBackOff whose logs name something other than the cause.                            */}}
{{/* ---------------------------------------------------------------------------------------- */}}

{{/*
The four Supabase credentials are a SET.

`anonKey` and `serviceRoleKey` are JWTs signed by `jwtSecret`. Generating one without the others
-- the obvious `randAlphaNum` convenience -- invalidates both pre-minted keys, and every request
through Kong's key-auth then fails against a stack that looks fine. So: all supplied, or none and
a legible refusal. The chart never generates them.

Skipped entirely when `existingSecret` is set, because the values are then not the chart's to see.
*/}}
{{- define "acs-cymru.validateSecrets" -}}
{{- if not .Values.secrets.existingSecret -}}
{{- $missing := list -}}
{{- range $field, $envName := dict "jwtSecret" "SUPABASE_JWT_SECRET" "anonKey" "SUPABASE_ANON_KEY" "serviceRoleKey" "SUPABASE_SERVICE_ROLE_KEY" "postgresPassword" "POSTGRES_PASSWORD" -}}
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
{{- if not .Values.secrets.fdwReaderPassword -}}
{{- $missing = append $missing "secrets.fdwReaderPassword (FDW_READER_PASSWORD, required -- Supabase's postgres_fdw mapping authenticates as fdw_reader, and the only alternative is the historian superuser)" -}}
{{- end -}}
{{/*
THE CREDENTIAL SERVICE'S TOKEN, for the same reason one line up and with a worse blast radius.

It exits 2 on anything shorter than 32 characters rather than running open -- correctly, because it
can mint a Mosquitto account for any edge node and mosquitto.acl turns an account into the ability
to publish Sparkplug telemetry AS that gateway. There is no safe default to fall back to.

But it is a SIDECAR IN THE BROKER'S POD (it needs a shared PID namespace to signal mosquitto), so
its refusal is not contained the way Grafana's would be: the pod never reaches Ready, and every
workload that waits on the broker -- ingestion, i3x-service, both e2e Jobs -- times out against a
broker that is running perfectly well. The rollout error then names i3x-service, which is neither
the cause nor anywhere near it.

32, not "not empty", because the length is the check the service actually applies.
*/}}
{{- if and .Values.gatewayCredential.enabled (lt (len (.Values.secrets.mqttCredentialServiceToken | default "")) 32) -}}
{{- $missing = append $missing "secrets.mqttCredentialServiceToken (MQTT_CREDENTIAL_SERVICE_TOKEN, 32+ characters, required when gatewayCredential.enabled)" -}}
{{- end -}}
{{- if $missing -}}
{{- fail (printf "\n\nacs-cymru: required credentials are not set:\n  - %s\n\nThese are a SET, not independent values: anonKey and serviceRoleKey are JWTs signed by\njwtSecret, so supplying some and not others yields a stack that reports healthy and rejects\nevery request at the gateway. The chart deliberately does not generate them.\n\nFor a local k3s stack:   helm install ... -f values-dev.yaml\nFor anything else:       copy values-prod.yaml.example and supply a matching set.\n" (join "\n  - " $missing)) -}}
{{- end -}}
{{/*
THE DEMO SECRET IS REFUSED ON ANYTHING THAT IS NOT PLAINLY LOCAL.

`values-dev.yaml` legitimately carries the published Supabase demo credentials, and CI installs
with it every run — so this cannot simply ban the value. What it bans is the combination that has
no innocent reading: the demo JWT secret together with a public hostname somebody chose.

Since Kong began running `key-auth`, anonKey and serviceRoleKey are GATEWAY API KEYS as well as
JWTs. A deployment on the demo set is one where the published keys in this repository authenticate
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
{{- fail (printf "\n\nacs-cymru: refusing to install on the PUBLISHED demo credentials with a public hostname.\n\n  global.publicBaseDomain = %s\n  secrets.jwtSecret       = the Supabase demo value, committed in this repository\n\nanonKey and serviceRoleKey are signed by that secret AND are registered as Kong API keys, so this\ndeployment would authenticate anyone holding a file that ships with the source.\n\nGenerate a matching set:\n\n  node scripts/setup.mjs        # writes .env with fresh, internally consistent credentials\n\nthen carry those four values into your own values file (see values-prod.yaml.example), or set\nsecrets.existingSecret to a Secret managed outside the chart.\n\nIf this really is a private lab, name it as one -- a publicBaseDomain under 127.0.0.1.nip.io,\nlocalhost, 192.168.*, .local, .localhost or .internal is accepted as-is.\n" $domain) -}}
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
{{- end -}}
{{- end -}}

{{/*
Realtime's Service name must have `realtime-dev` as its LEADING LABEL.

Realtime reads the tenant id from the leading hostname label of the Host header, not from the JWT.
Kong runs preserve_host: false, so the upstream Host comes from the Service name -- rename it and
every WebSocket handshake fails with a bare 403 that names nothing. Same guard supabase-kong-init
applies to REALTIME_UPSTREAM_URL on the Compose side.
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
supabase-db: a single Postgres instance with no replication; HA needs an operator
timescaledb: likewise
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
supabase-kong: the gateway is configured declaratively and holds no state between requests
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

WHY THE RENDER AND NOT THE POD. `mosquitto.acl` pins the topic's edge-node segment to the
connecting username (`pattern readwrite spBv1.0/+/+/%u/#`), and `verify_gateway_binding()` requires
that same segment to be the gateway row's GENERATED `sparkplug_id`. So a friendly username here
does not fail: the client authenticates perfectly, and then the broker silently drops every
message it publishes. Nothing logs a reason at either end -- the symptom is an edge node that
connects and produces no telemetry, which reads as a broken simulator or a broken ingestion daemon.

The monitoring password is checked because the broker's own probes authenticate as that account:
an empty one leaves the pod permanently NotReady and takes down every workload that waits on it,
reporting nothing about MQTT.

Skipped when `existingSecret` is set -- the values are then not the chart's to see.
*/}}
{{- define "acs-cymru.validateMqttPrincipals" -}}
{{- if not .Values.secrets.existingSecret -}}
{{- range $field := list "mqttSimulatorUser" "mqttValidatorUser" -}}
{{- $v := get $.Values.secrets $field -}}
{{- if not (regexMatch "^gwy[0-9a-f]{21}$" $v) -}}
{{- fail (printf "\n\nacs-cymru: secrets.%s is %q, which is not a gateway sparkplug_id.\n\nIt must be 'gwy' followed by exactly 21 lowercase hex characters. mosquitto.acl confines each\nclient to `spBv1.0/+/+/%%u/#`, and ingestion's verify_gateway_binding() requires that same topic\nsegment to be the gateway row's GENERATED sparkplug_id -- so any other value AUTHENTICATES FINE\nand then has every published message silently dropped by the broker, with nothing logged at\neither end.\n\nThe id is derived from the row's pinned UUID: 'gwy' + the first 21 hex characters of it.\n  10000000-0000-4000-8000-000000000001 -> gwy100000000000400080000  (Virtual_Gateway_NodeRED)\n  11000000-0000-4000-8000-000000000001 -> gwy110000000000400080000  (validate.py's gateway)\n" $field $v) -}}
{{- end -}}
{{- end -}}
{{- if not .Values.secrets.mqttMonitorPassword -}}
{{- fail "\n\nacs-cymru: secrets.mqttMonitorPassword is empty.\n\nThe broker's startup, readiness and liveness probes authenticate as this account (it can read\n$SYS and publish nothing). Without it mosquitto never becomes Ready, and every workload that\nwaits on it fails to start -- an outage whose events mention neither MQTT nor this setting.\n" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "acs-cymru.validate" -}}
{{- include "acs-cymru.validateSecrets" . -}}
{{- include "acs-cymru.validateMqttPrincipals" . -}}
{{- include "acs-cymru.validateRealtime" . -}}
{{- include "acs-cymru.validateRealtimeServiceName" . -}}
{{- include "acs-cymru.validatePublicUrls" . -}}
{{- include "acs-cymru.validateScheme" . -}}
{{- include "acs-cymru.validateIngress" . -}}
{{- include "acs-cymru.validateBrokerTls" . -}}
{{- include "acs-cymru.validateAutoscaling" . -}}
{{- end -}}

{{/*
Broker client transport, shared by the ingestion daemon and Node-RED.

DEFINED ONCE because the two must agree. They read the SAME environment variable names --
ingestion.py's `configure_mqtt_tls()` and node-red-init.mjs's transport reconciliation were written
against one contract deliberately -- so a port set for one and not the other is a class of mistake
worth making unrepresentable. Same reasoning as the NetworkPolicy edge list.
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
Secret into the ingestion daemon and Node-RED would hand both of them the key that lets anything
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

5433 exists only to keep docker-compose's published port off a developer's local PostgreSQL; the
server listens on 5432. The postgres_fdw foreign server in 0001_baseline_schema.sql is the reader
that matters here -- a wrong port there fails as a relation-level error from PostgREST rather than
as a connection error, so it reads as a schema fault. `helm test` (M6) queries the foreign table to
pin it.
*/}}
{{- define "acs-cymru.timescale.host" -}}timescaledb{{- end -}}
{{- define "acs-cymru.timescale.port" -}}5432{{- end -}}

{{- define "acs-cymru.supabaseDb.host" -}}supabase-db{{- end -}}
{{- define "acs-cymru.supabaseDb.port" -}}5432{{- end -}}

{{/* Kong, as reached from INSIDE the cluster. The browser-facing address is publicUrls.supabase. */}}
{{- define "acs-cymru.supabase.internalUrl" -}}http://supabase-kong:8000{{- end -}}

{{/*
DSN builder. Usage:
  {{ include "acs-cymru.dsn" (dict "user" "authenticator" "password" $pw "host" "supabase-db" "port" 5432 "db" "postgres" "params" "sslmode=disable") }}
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
-- Service names match the Compose service names, so they are constants.
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
The browser origins Kong echoes an Access-Control-Allow-Origin for -- a JSON array, substituted
into `__CORS_ORIGINS__` in files/kong/kong.yml.

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
{{- fail "\n\nacs-cymru: Kong would be given an EMPTY browser-origin list.\n\npublicUrls.supabase names a browser-facing API, but no origin could be derived for the\ndashboard or for Swagger UI -- so Kong would start cleanly and then refuse every browser\nrequest to it, returning 200 with no Access-Control-Allow-Origin. That presents as a\ndashboard which signs in and then shows empty tables, with nothing failing anywhere you\nwould think to look.\n\nSet global.publicBaseDomain, or publicUrls.frontend / publicUrls.docs, or\nglobal.corsExtraOrigins if this deployment is reached only through a proxy whose hostname\nthe chart cannot derive.\n" -}}
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
{{/* EITHER GATEWAY, and the service name follows whichever it is. Gated on supabaseKong alone,
     promoting to Envoy removed the API's ingress rule entirely: the dashboard loads and every
     call 404s at the controller, with a rendered Ingress that looks correct because the route it
     is missing was never written. */}}
{{- if or .Values.supabaseKong.enabled .Values.supabaseEnvoy.enabled -}}
{{- $gwSvc := ternary .Values.supabaseEnvoy.serviceName "supabase-kong" .Values.supabaseEnvoy.enabled -}}
{{- $routes = append $routes (dict "name" "supabase" "host" (include "acs-cymru.hostOf" (dict "ctx" . "name" "supabase")) "service" $gwSvc "port" 8000) -}}
{{- end -}}
{{- if .Values.nodeRed.enabled -}}
{{- $routes = append $routes (dict "name" "nodered" "host" (include "acs-cymru.hostOf" (dict "ctx" . "name" "nodered")) "service" "node-red" "port" 1880) -}}
{{- end -}}
{{- if .Values.grafana.enabled -}}
{{- $routes = append $routes (dict "name" "grafana" "host" (include "acs-cymru.hostOf" (dict "ctx" . "name" "grafana")) "service" "grafana" "port" 3000) -}}
{{- end -}}
{{- if .Values.supabaseStudio.enabled -}}
{{- $routes = append $routes (dict "name" "studio" "host" (include "acs-cymru.hostOf" (dict "ctx" . "name" "studio")) "service" "supabase-studio" "port" 3000) -}}
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
  {{- /* Optional `env`, for a probe that needs a credential -- a Kong route under key-auth, say.
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
The MQTT principals the chart itself provisions, as env, for the two containers that write them:
the broker's assemble-config initContainer and the credential-reload sidecar.

ONE DEFINITION, because the two must agree exactly. They write the same password file, and a
principal present in one and absent from the other produces a broker that authenticates a client
until the next reload and then stops -- an intermittent CONNACK 5 that looks like a flapping
network rather than a template that disagrees with itself.

FIVE PLATFORM PRINCIPALS AND FOUR SIMULATED CELL GATEWAYS. The gateways are here for a different
reason from the rest: node-red-init fails closed when a broker node in the shipped flow declares an
`acsCredentialsEnv` pair it cannot find, so an install without them does not degrade to a quiet
simulator -- the init container exits 1 and Node-RED never starts. They are ordinary accounts to
the broker, and the empty-password skip below is what keeps them optional.

Consumers (ingestion, i3x, node-red, the validator Job) each take only THEIR OWN pair, so this is
deliberately not used there: the point of the split is that no workload holds another's credential.
*/}}
{{- define "acs-cymru.mqttPrincipals" -}}
INGESTION I3X SIMULATOR VALIDATOR MONITOR GW_CNC_MACHINING GW_ROBOTIC_ASSEMBLY GW_AGV_FLEET GW_FACILITY_BMS
{{- end -}}

{{- define "acs-cymru.mqttPrincipalEnv" -}}
{{- $secretName := include "acs-cymru.secretName" . -}}
{{- range $p := splitList " " (include "acs-cymru.mqttPrincipals" .) }}
{{ include "acs-cymru.secretEnv" (dict "name" (printf "MQTT_%s_USER" $p) "secretName" $secretName "key" (printf "MQTT_%s_USER" $p)) }}
{{ include "acs-cymru.secretEnv" (dict "name" (printf "MQTT_%s_PASSWORD" $p) "secretName" $secretName "key" (printf "MQTT_%s_PASSWORD" $p)) }}
{{- end }}
{{- end -}}

{{/*
The shell fragment that upserts those accounts into an ALREADY-ASSEMBLED password file.

`mosquitto_passwd -b` upserts, so this is idempotent and re-applying it on every start is what
makes a rotated password in values reach the broker on the next restart.

NEVER `-c` HERE. That flag CREATES the file, discarding every per-gateway credential provisioned
since the last upgrade -- the whole fleet drops off the broker at once with `helm upgrade` as the
only clue. It is the single most destructive character available in this script.

An EMPTY password skips that account rather than writing an empty one. `mqttValidatorPassword` is
the case that matters: the validator is a fixture, so a production install leaves it unset and
should simply not have the account, not fail to boot over a credential it never wanted. The four
`mqttGw*Password` values are fixtures in the same sense -- a plant that has retired the simulated
shopfloor leaves them unset, and no account is created.
*/}}
{{- define "acs-cymru.mqttPrincipalUpserts" -}}
for p in {{ include "acs-cymru.mqttPrincipals" . }}; do
  eval user="\$MQTT_${p}_USER"
  eval pass="\$MQTT_${p}_PASSWORD"
  if [ -n "$pass" ]; then
    mosquitto_passwd -b /mosquitto/config/password_file "$user" "$pass"
  else
    echo "MQTT_${p}_PASSWORD is empty -- not creating an account for '${user}'."
  fi
done
# The monitoring account is the one that cannot be skipped: the broker's own probes subscribe to
# $SYS as it, so without it the pod never becomes ready and every workload that waits on mosquitto
# fails to start -- an outage whose message names neither MQTT nor this file.
if [ -z "$MQTT_MONITOR_PASSWORD" ]; then
  echo 'MQTT_MONITOR_PASSWORD must be set: the readiness, liveness and startup probes authenticate as this account, so an empty one leaves the broker permanently NotReady.' >&2
  exit 1
fi
{{- end -}}

{{/*
Node-RED authentication environment — the chart's counterpart to docker-compose.yml's
`x-nodered-auth-env` anchor, and load-bearing for the same reason.

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
{{ include "acs-cymru.secretEnv" (dict "name" "SUPABASE_ANON_KEY" "secretName" $secretName "key" "SUPABASE_ANON_KEY") }}
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
