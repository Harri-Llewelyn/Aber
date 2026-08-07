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

{{- define "factoryplus.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Release-qualified name, for objects that are NOT addressed by name from inside the stack
(Secrets, ConfigMaps, Jobs). Services deliberately do not use this -- see below.
*/}}
{{- define "factoryplus.fullname" -}}
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

Do not "tidy" a Service name. See CLAUDE.md "Deployment Targets".
*/}}
{{- define "factoryplus.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "factoryplus.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: factoryplus
{{- with .Values.global.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* Selector labels for one component. Usage: (dict "ctx" $ "component" "timescaledb") */}}
{{- define "factoryplus.selectorLabels" -}}
app.kubernetes.io/name: {{ include "factoryplus.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "factoryplus.componentLabels" -}}
{{ include "factoryplus.labels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "factoryplus.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "factoryplus.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* Resolve a per-component storageClass, falling back to the global one. */}}
{{- define "factoryplus.storageClass" -}}
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

  {{ include "factoryplus.image" (dict "image" .Values.ingestion.image "ctx" .) }}
*/}}
{{- define "factoryplus.image" -}}
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
{{- define "factoryplus.validateSecrets" -}}
{{- if not .Values.secrets.existingSecret -}}
{{- $missing := list -}}
{{- range $field, $envName := dict "jwtSecret" "SUPABASE_JWT_SECRET" "anonKey" "SUPABASE_ANON_KEY" "serviceRoleKey" "SUPABASE_SERVICE_ROLE_KEY" "postgresPassword" "POSTGRES_PASSWORD" -}}
{{- if not (get $.Values.secrets $field) -}}
{{- $missing = append $missing (printf "secrets.%s (%s)" $field $envName) -}}
{{- end -}}
{{- end -}}
{{- if $missing -}}
{{- fail (printf "\n\nfactoryplus: required credentials are not set:\n  - %s\n\nThese are a SET, not independent values: anonKey and serviceRoleKey are JWTs signed by\njwtSecret, so supplying some and not others yields a stack that reports healthy and rejects\nevery request at the gateway. The chart deliberately does not generate them.\n\nFor a local k3s stack:   helm install ... -f values-dev.yaml\nFor anything else:       copy values-prod.yaml.example and supply a matching set.\n" (join "\n  - " $missing)) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Realtime's two keys have LENGTHS ENFORCED BY THE CONTAINER, which refuses to boot otherwise --
dbEncKey exactly 16 characters, secretKeyBase at least 64. Asserted here so the failure is one
Helm error instead of a restarting pod with an Elixir stacktrace.

Only checked when realtime is enabled AND the chart owns the secret.
*/}}
{{- define "factoryplus.validateRealtime" -}}
{{- if and .Values.realtime.enabled (not .Values.secrets.existingSecret) -}}
{{- $enc := .Values.secrets.realtimeDbEncKey | default "" -}}
{{- $base := .Values.secrets.realtimeSecretKeyBase | default "" -}}
{{- if ne (len $enc) 16 -}}
{{- fail (printf "\n\nfactoryplus: secrets.realtimeDbEncKey must be EXACTLY 16 characters (got %d).\nsupabase/realtime refuses to boot otherwise. Generate one with:  openssl rand -hex 8\n" (len $enc)) -}}
{{- end -}}
{{- if lt (len $base) 64 -}}
{{- fail (printf "\n\nfactoryplus: secrets.realtimeSecretKeyBase must be AT LEAST 64 characters (got %d).\nsupabase/realtime refuses to boot otherwise. Generate one with:  openssl rand -hex 32\n" (len $base)) -}}
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
{{- define "factoryplus.validateRealtimeServiceName" -}}
{{- if .Values.realtime.enabled -}}
{{- $name := .Values.realtime.serviceName | default "" -}}
{{- if not (or (eq $name "realtime-dev") (hasPrefix "realtime-dev." $name)) -}}
{{- fail (printf "\n\nfactoryplus: realtime.serviceName must be `realtime-dev` (got %q).\n\nRealtime resolves its TENANT from the leading hostname label of the Host header, and\n`realtime-dev` is the tenant SEED_SELF_HOST creates. Any other name makes every WebSocket\nhandshake fail with a bare 403 that does not mention the tenant. See plan §3.4.\n" $name) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
A browser-facing URL that resolves to the empty string is worse than a missing one.

GoTrue builds every user-facing redirect from GOTRUE_SITE_URL, including the OAuth consent
redirect; empty means /oauth/authorize sends the browser to `/oauth/consent` with no origin, and
Grafana and Node-RED SSO both fail at the consent step with nothing naming the cause. The OAuth
`redirect_uris` db-init registers would be empty too, so the clients could never match.

Phase 1 (data tier only) genuinely does not need a domain, which is why this is gated on
supabaseAuth rather than asserted unconditionally.
*/}}
{{- define "factoryplus.validatePublicUrls" -}}
{{- if .Values.supabaseAuth.enabled -}}
{{- $missing := list -}}
{{- if not (include "factoryplus.frontendUrl" .) }}{{ $missing = append $missing "frontend (app.<domain>)" }}{{- end -}}
{{- if not (include "factoryplus.supabaseUrl" .) }}{{ $missing = append $missing "supabase (api.<domain>)" }}{{- end -}}
{{- if $missing -}}
{{- fail (printf "\n\nfactoryplus: no browser-facing URL could be resolved for:\n  - %s\n\nSet global.publicBaseDomain (every host is derived from it), or set publicUrls.* explicitly.\n\nThis is not cosmetic. GoTrue builds every user-facing redirect from GOTRUE_SITE_URL, and an empty\none sends the browser to a path with no origin -- Grafana and Node-RED SSO then fail at the consent\nstep with nothing naming the cause. The OAuth redirect_uris db-init registers would be empty too,\nso no client could ever match one.\n" (join "\n  - " $missing)) -}}
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
{{- define "factoryplus.validateScheme" -}}
{{- if and .Values.ingress.enabled .Values.ingress.tls.enabled (ne .Values.global.scheme "https") -}}
{{- fail (printf "\n\nfactoryplus: ingress.tls.enabled is true but global.scheme is %q.\n\nEvery browser-facing URL -- and therefore every OAuth redirect_uri db-init registers -- is composed\nfrom global.scheme. With TLS terminating at the ingress the browser arrives over https and presents\nan https redirect_uri, while GoTrue holds the http one: /oauth/authorize answers `invalid\nredirect_uri`, and it reads as a Grafana or Node-RED fault. Grafana's root_url would send users to\nhttp as well, losing the session cookie.\n\nNothing crashes -- only sign-in breaks. Set global.scheme: https.\n" .Values.global.scheme) -}}
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
{{- define "factoryplus.validateIngress" -}}
{{- if .Values.ingress.enabled -}}
{{- $hosts := list -}}
{{- range (include "factoryplus.ingressRoutes" . | fromYamlArray) -}}
{{- if .host }}{{ $hosts = append $hosts .host }}{{ end -}}
{{- end -}}
{{- if not $hosts -}}
{{- fail "\n\nfactoryplus: ingress.enabled is true but no route resolved a hostname.\n\nEvery host is derived from global.publicBaseDomain (or an explicit publicUrls.* entry). With neither\nset this would render an Ingress with empty `host:` fields -- which the API server ACCEPTS, and which\nthen matches EVERY request arriving at the controller, so unrelated traffic reaches the dashboard and\nnone of the intended hostnames route.\n\nSet global.publicBaseDomain, or ingress.enabled=false to run the stack cluster-internal only.\n" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
The single-writer workloads, and why each one is.

USED BY THREE THINGS: the autoscaling guard, the PDB template, and CI. One list, so "which workloads
must never be scaled" has one answer rather than three that can drift.
*/}}
{{- define "factoryplus.singleWriterWorkloads" -}}
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
An HPA on a single-writer workload.

REFUSED, not warned about. Every one of those workloads is one replica for a reason recorded in its
own manifest, and the damage from scaling them is SILENT -- no error, no crash, just duplicated
telemetry, a split fleet, or two processes racing on one volume. An autoscaler makes that happen at
3am under load, which is the worst possible moment to discover it.
*/}}
{{- define "factoryplus.validateAutoscaling" -}}
{{- if .Values.autoscaling.enabled -}}
{{- $forbidden := list "ingestion" "node-red" "mosquitto" "realtime" "supabase-storage" "grafana" "supabase-db" "timescaledb" -}}
{{- range .Values.autoscaling.components -}}
{{- if has . $forbidden -}}
{{- fail (printf "\n\nfactoryplus: autoscaling.components includes %q, which is a SINGLE-WRITER workload.\n\nRefused rather than warned about. The reasons are per-component and recorded in each manifest, but\nthey share a shape: the damage is SILENT. Scaling `ingestion` duplicates every telemetry row, every\nquarantine decision and every append-only audit row -- no error, no crash. An autoscaler makes that\nhappen under load, which is the worst moment to discover it.\n\nOnly these may autoscale: supabase-rest, supabase-kong, supabase-functions, frontend.\n" .) -}}
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
{{- define "factoryplus.validateBrokerTls" -}}
{{- if .Values.mosquitto.enabled -}}
{{- if and .Values.mosquitto.external.enabled (not .Values.mosquitto.external.plaintext) (not .Values.mosquitto.tls.enabled) -}}
{{- fail "\n\nfactoryplus: mosquitto.external.plaintext=false with mosquitto.tls.enabled=false.\n\nThat asks for an external broker Service with no ports on it at all -- 1883 withdrawn and 8883 never\nadded. The API server would refuse it as `spec.ports: Required value`, which names neither setting.\n\nEither turn TLS on (see deploy/k8s/internal-ca.yaml), or set mosquitto.external.enabled=false if the\nintent is no external broker at all.\n" -}}
{{- end -}}
{{- if and .Values.mosquitto.tls.enabled .Values.mosquitto.external.enabled (eq .Values.mosquitto.external.type "LoadBalancer") -}}
{{- if and (eq (toString .Values.mosquitto.external.loadBalancerIP) "") (not .Values.mosquitto.tls.extraIpSans) (not .Values.mosquitto.tls.extraDnsSans) -}}
{{- fail (printf "\n\nfactoryplus: broker TLS is on with an external LoadBalancer, but the certificate would carry no\nexternal identity -- no IP SAN and no DNS SAN beyond the in-cluster name.\n\nGateways dial the broker BY ADDRESS; there is rarely plant DNS for it. A certificate with no IP SAN\nfails verification on every gateway while the in-cluster clients -- which connect to `mosquitto` --\nverify perfectly. The stack reports healthy, the demo simulator keeps producing telemetry, and the\nfleet is silently off.\n\nOnce the cluster has assigned the address:\n\n  kubectl -n %s get svc mosquitto-external -o jsonpath='{.status.loadBalancer.ingress[0].ip}'\n\nthen set ONE of:\n  mosquitto.tls.extraIpSans={<that address>}      # gateways dial the IP (usual case)\n  mosquitto.external.loadBalancerIP=<address>     # pin it, and it is added to the SANs for you\n  mosquitto.tls.extraDnsSans={mqtt.plant.example} # gateways dial a plant DNS name\n" .Release.Namespace)  -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Single entry point, included once from NOTES.txt so every render runs every check.

ORDER IS DELIBERATE, most fundamental first: a stack with no credentials should be told that, not
told about the hostnames it also lacks.
*/}}
{{- define "factoryplus.validate" -}}
{{- include "factoryplus.validateSecrets" . -}}
{{- include "factoryplus.validateRealtime" . -}}
{{- include "factoryplus.validateRealtimeServiceName" . -}}
{{- include "factoryplus.validatePublicUrls" . -}}
{{- include "factoryplus.validateScheme" . -}}
{{- include "factoryplus.validateIngress" . -}}
{{- include "factoryplus.validateBrokerTls" . -}}
{{- include "factoryplus.validateAutoscaling" . -}}
{{- end -}}

{{/*
Broker client transport, shared by the ingestion daemon and Node-RED.

DEFINED ONCE because the two must agree. They read the SAME environment variable names --
ingestion.py's `configure_mqtt_tls()` and node-red-init.mjs's transport reconciliation were written
against one contract deliberately -- so a port set for one and not the other is a class of mistake
worth making unrepresentable. Same reasoning as the NetworkPolicy edge list.
*/}}
{{- define "factoryplus.brokerClientEnv" -}}
{{- $tls := .Values.mosquitto.tls -}}
- name: MQTT_HOST
  value: mosquitto
{{- if and $tls.enabled $tls.internalClients }}
- name: MQTT_PORT
  value: "8883"
- name: MQTT_TLS_ENABLED
  value: "true"
{{- /* Projected from the broker's certificate Secret -- see factoryplus.brokerClientCaVolume for
       why only ca.crt is mounted and not the whole Secret. */}}
- name: MQTT_TLS_CA_FILE
  value: /etc/factoryplus/broker-ca/ca.crt
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
{{- define "factoryplus.brokerClientCaVolume" -}}
- name: broker-ca
  secret:
    secretName: {{ .Values.mosquitto.tls.secretName }}
    defaultMode: 0444
    items:
      - key: ca.crt
        path: ca.crt
{{- end -}}

{{- define "factoryplus.brokerClientCaMount" -}}
- name: broker-ca
  mountPath: /etc/factoryplus/broker-ca
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
{{- define "factoryplus.timescale.host" -}}timescaledb{{- end -}}
{{- define "factoryplus.timescale.port" -}}5432{{- end -}}

{{- define "factoryplus.supabaseDb.host" -}}supabase-db{{- end -}}
{{- define "factoryplus.supabaseDb.port" -}}5432{{- end -}}

{{/* Kong, as reached from INSIDE the cluster. The browser-facing address is publicUrls.supabase. */}}
{{- define "factoryplus.supabase.internalUrl" -}}http://supabase-kong:8000{{- end -}}

{{/*
DSN builder. Usage:
  {{ include "factoryplus.dsn" (dict "user" "authenticator" "password" $pw "host" "supabase-db" "port" 5432 "db" "postgres" "params" "sslmode=disable") }}
The password is urlquery-escaped: a generated password containing @ or / silently truncates the
DSN at the wrong character and the failure reads as a bad hostname.
*/}}
{{- define "factoryplus.dsn" -}}
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
{{- define "factoryplus.publicUrl" -}}
{{- $explicit := index .ctx.Values.publicUrls .key -}}
{{- if $explicit -}}
{{- $explicit | trimSuffix "/" -}}
{{- else if .ctx.Values.global.publicBaseDomain -}}
{{- printf "%s://%s.%s" .ctx.Values.global.scheme .sub .ctx.Values.global.publicBaseDomain -}}
{{- end -}}
{{- end -}}

{{- define "factoryplus.frontendUrl" -}}{{ include "factoryplus.publicUrl" (dict "ctx" . "key" "frontend" "sub" "app") }}{{- end -}}
{{- define "factoryplus.supabaseUrl" -}}{{ include "factoryplus.publicUrl" (dict "ctx" . "key" "supabase" "sub" "api") }}{{- end -}}
{{- define "factoryplus.grafanaUrl" -}}{{ include "factoryplus.publicUrl" (dict "ctx" . "key" "grafana" "sub" "grafana") }}{{- end -}}
{{- define "factoryplus.noderedUrl" -}}{{ include "factoryplus.publicUrl" (dict "ctx" . "key" "nodered" "sub" "nodered") }}{{- end -}}
{{- define "factoryplus.studioUrl" -}}{{ include "factoryplus.publicUrl" (dict "ctx" . "key" "studio" "sub" "studio") }}{{- end -}}
{{- define "factoryplus.docsUrl" -}}{{ include "factoryplus.publicUrl" (dict "ctx" . "key" "docs" "sub" "docs") }}{{- end -}}
{{- define "factoryplus.mqttUrl" -}}{{ include "factoryplus.publicUrl" (dict "ctx" . "key" "mqtt" "sub" "mqtt") }}{{- end -}}
{{/*
The i3X server's browser-facing URL.

Derived here like every other public URL rather than written as a literal, because it has more than
one consumer: the Ingress rule, NOTES.txt, and -- for anyone pointing the CESMII conformance suite
or the MCP server at this deployment -- the value of `I3X_BASE_URL`. One definition means an ingress
hostname cannot disagree with what is documented as the endpoint.
*/}}
{{- define "factoryplus.i3xUrl" -}}{{ include "factoryplus.publicUrl" (dict "ctx" . "key" "i3x" "sub" "i3x") }}{{- end -}}

{{/*
Host only, for an Ingress rule -- the scheme and any path stripped off.

Ingress `host` is a DNS name and rejects a scheme; feeding it a URL produces a rule that matches
nothing, and the Ingress is accepted, so it fails as a 404 from the controller's default backend
rather than as a validation error. The URL helpers above are the single source, so the host and the
URL a service is told to advertise can never disagree.
*/}}
{{- define "factoryplus.hostOf" -}}
{{- $url := include (printf "factoryplus.%sUrl" .name) .ctx -}}
{{- if $url -}}
{{- regexReplaceAll "^[a-z]+://" $url "" | splitList "/" | first -}}
{{- end -}}
{{- end -}}

{{/*
Every ingress route in one place: subdomain, backend Service, port, and whether it is deployed.

Built here rather than in ingress.yaml so the ingress and anything else that needs to reason about
the public surface (NOTES.txt, and Phase 7's NetworkPolicies) read one definition.
*/}}
{{- define "factoryplus.ingressRoutes" -}}
{{- $routes := list -}}
{{- if .Values.frontend.enabled -}}
{{- $routes = append $routes (dict "name" "frontend" "host" (include "factoryplus.hostOf" (dict "ctx" . "name" "frontend")) "service" "frontend" "port" 3000) -}}
{{- end -}}
{{- if .Values.supabaseKong.enabled -}}
{{- $routes = append $routes (dict "name" "supabase" "host" (include "factoryplus.hostOf" (dict "ctx" . "name" "supabase")) "service" "supabase-kong" "port" 8000) -}}
{{- end -}}
{{- if .Values.nodeRed.enabled -}}
{{- $routes = append $routes (dict "name" "nodered" "host" (include "factoryplus.hostOf" (dict "ctx" . "name" "nodered")) "service" "node-red" "port" 1880) -}}
{{- end -}}
{{- if .Values.grafana.enabled -}}
{{- $routes = append $routes (dict "name" "grafana" "host" (include "factoryplus.hostOf" (dict "ctx" . "name" "grafana")) "service" "grafana" "port" 3000) -}}
{{- end -}}
{{- if .Values.supabaseStudio.enabled -}}
{{- $routes = append $routes (dict "name" "studio" "host" (include "factoryplus.hostOf" (dict "ctx" . "name" "studio")) "service" "supabase-studio" "port" 3000) -}}
{{- end -}}
{{- if .Values.swaggerUi.enabled -}}
{{- $routes = append $routes (dict "name" "docs" "host" (include "factoryplus.hostOf" (dict "ctx" . "name" "docs")) "service" "swagger-ui" "port" 8080) -}}
{{- end -}}
{{- if .Values.i3xService.enabled -}}
{{/* The i3X server is browser- and client-facing: the MCP server, the i3X Explorer and any
     conformance run all reach it over HTTP from outside the cluster, so it needs a route of its
     own. `GET /info` is unauthenticated by spec, so this hostname exposes a capabilities document
     to anyone who can reach the ingress -- which is intended (it is the health check) and is why
     nothing about the address space is in it. */}}
{{- $routes = append $routes (dict "name" "i3x" "host" (include "factoryplus.hostOf" (dict "ctx" . "name" "i3x")) "service" "i3x-service" "port" 8090) -}}
{{- end -}}
{{- if .Values.mosquitto.enabled -}}
{{/* MQTT over WEBSOCKETS only -- port 9001. Raw MQTT on 1883 is TCP and cannot ride an HTTP
     Ingress at all; that is what the mosquitto-external LoadBalancer is for. */}}
{{- $routes = append $routes (dict "name" "mqtt" "host" (include "factoryplus.hostOf" (dict "ctx" . "name" "mqtt")) "service" "mosquitto" "port" 9001) -}}
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
*/}}
{{- define "factoryplus.waitFor" -}}
- name: {{ .name }}
  image: {{ .image | default "busybox:1.36" }}
  imagePullPolicy: IfNotPresent
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
*/}}
{{- define "factoryplus.waitForPostgres" -}}
- name: {{ .name }}
  image: "{{ .ctx.Values.supabaseDb.image.repository }}:{{ .ctx.Values.supabaseDb.image.tag }}"
  imagePullPolicy: {{ .ctx.Values.supabaseDb.image.pullPolicy }}
  env:
    - name: PGPASSWORD
      valueFrom:
        secretKeyRef:
          name: {{ include "factoryplus.secretName" .ctx }}
          key: {{ .passwordKey }}
  command:
    - /bin/sh
    - -c
    - |
      deadline=$(( $(date +%s) + {{ .ctx.Values.initJobs.waitTimeout }} ))
      until psql -h {{ .host }} -p {{ .port }} -U {{ .user }} -d {{ .db }} -c 'SELECT 1;' >/dev/null 2>&1; do
        if [ "$(date +%s)" -ge "$deadline" ]; then
          echo "timed out after {{ .ctx.Values.initJobs.waitTimeout }}s waiting for {{ .host }}" >&2
          exit 1
        fi
        echo "waiting for {{ .host }} to accept queries ..."
        sleep 3
      done
      echo "{{ .host }} is accepting queries"
{{- end -}}

{{/* Pull one key from the chart's Secret as an env var. */}}
{{- define "factoryplus.secretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ .secretName }}
      key: {{ .key }}
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

Consumed in Phase 4; defined here so the anchor's guarantee is established with the helpers rather
than bolted on beside the Deployment that happens to need it first.
*/}}
{{- define "factoryplus.noderedAuthEnv" -}}
{{- $secretName := include "factoryplus.secretName" . -}}
{{- $nodered := .Values.publicUrls.nodered | default (printf "%s://nodered.%s" .Values.global.scheme .Values.global.publicBaseDomain) -}}
{{- $supabase := .Values.publicUrls.supabase | default (printf "%s://api.%s" .Values.global.scheme .Values.global.publicBaseDomain) -}}
{{ include "factoryplus.secretEnv" (dict "name" "NODERED_CREDENTIAL_SECRET" "secretName" $secretName "key" "NODERED_CREDENTIAL_SECRET") }}
{{ include "factoryplus.secretEnv" (dict "name" "NODERED_OAUTH_CLIENT_SECRET" "secretName" $secretName "key" "NODERED_OAUTH_CLIENT_SECRET") }}
{{ include "factoryplus.secretEnv" (dict "name" "NODERED_WEBHOOK_JWT_SECRET" "secretName" $secretName "key" "NODERED_WEBHOOK_JWT_SECRET") }}
{{ include "factoryplus.secretEnv" (dict "name" "NODERED_ADMIN_TOKEN" "secretName" $secretName "key" "NODERED_ADMIN_TOKEN") }}
{{ include "factoryplus.secretEnv" (dict "name" "SUPABASE_JWT_SECRET" "secretName" $secretName "key" "SUPABASE_JWT_SECRET") }}
{{ include "factoryplus.secretEnv" (dict "name" "SUPABASE_ANON_KEY" "secretName" $secretName "key" "SUPABASE_ANON_KEY") }}
- name: NODERED_OAUTH_CLIENT_ID
  value: {{ .Values.nodeRed.oauthClientId | default "c0ffee00-0000-4000-8000-000000000002" | quote }}
{{/* auth_url is followed by the BROWSER, so it is the ingress address. token_url and userinfo are
     called by the CONTAINER, so they are in-cluster. Using one for both is the classic way this
     breaks -- a browser cannot resolve `supabase-kong`, and the container's 127.0.0.1 is itself. */}}
- name: NODERED_OAUTH_AUTH_URL
  value: {{ printf "%s/auth/v1/oauth/authorize" $supabase | quote }}
- name: NODERED_OAUTH_TOKEN_URL
  value: {{ printf "%s/auth/v1/oauth/token" (include "factoryplus.supabase.internalUrl" .) | quote }}
- name: NODERED_USERINFO_URL
  value: {{ printf "%s/functions/v1/nodered-userinfo" (include "factoryplus.supabase.internalUrl" .) | quote }}
{{/* Must match redirect_uris in auth.oauth_clients exactly, or /oauth/authorize answers
     "invalid redirect_uri". Both are built from publicUrls.nodered so they cannot drift. */}}
- name: NODERED_OAUTH_CALLBACK_URL
  value: {{ printf "%s/auth/strategy/callback" $nodered | quote }}
{{- end -}}
