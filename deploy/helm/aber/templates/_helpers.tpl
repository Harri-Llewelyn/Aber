{{/*
Shared template helpers: the values several services must be handed identically.

  1. Names and labels   2. Validation, which fails the render   3. Connection strings   4. Env blocks

Each helper carries what a reader needs at the line. The argument and the measurements behind them
are in docs/kubernetes-architecture.md, "What the shared helpers decide".
*/}}

{{/* ======================================================================================== */}}
{{/* 1. Names and labels */}}
{{/* ======================================================================================== */}}
{{- define "aber.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Release-qualified name, for objects not addressed by name from inside the stack (Secrets,
ConfigMaps, Jobs). Services deliberately do not use it; see aber.labels.
*/}}
{{- define "aber.fullname" -}}
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
SERVICE NAMES ARE NOT PREFIXED. They are the component names, so in-cluster DNS resolves
supabase-envoy:8000, timescaledb:5432 and mosquitto:1883, the URLs grafana.ini, settings.js and the
edge-function environment carry. Two releases in one namespace is not supported; use two
namespaces. Do not rename a Service to tidy it.
*/}}
{{- define "aber.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "aber.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: aber
{{- with .Values.global.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/*
Selector labels for one component. Usage: (dict "ctx" $ "component" "timescaledb")
*/}}
{{- define "aber.selectorLabels" -}}
app.kubernetes.io/name: {{ include "aber.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "aber.componentLabels" -}}
{{ include "aber.labels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "aber.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "aber.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
A per-component storageClass, falling back to the global one.
*/}}
{{- define "aber.storageClass" -}}
{{- $sc := .component.storageClass | default .ctx.Values.global.storageClass -}}
{{- if $sc -}}
storageClassName: {{ $sc | quote }}
{{- end -}}
{{- end -}}

{{/*
repository:tag for the images this repository BUILDS, an empty tag defaulting to the chart's
appVersion so chart and images ship from one release tag; an explicit tag still wins. Not for
third-party images: those pins carry couplings (realtime and storage-api migrate shared schemas on
boot, studio is Zod-coupled to a postgres-meta version, node-red is what settings.js depends on).

  {{ include "aber.image" (dict "image" .Values.ingestion.image "ctx" .) }}
*/}}
{{- define "aber.image" -}}
{{- $tag := .image.tag | default .ctx.Chart.AppVersion -}}
{{- if not $tag -}}
{{- fail "image tag resolved to empty: Chart.yaml has no appVersion and no explicit tag was set" -}}
{{- end -}}
{{- printf "%s:%s" .image.repository $tag -}}
{{- end -}}

{{/*
The image serving each Directory row, as JSON keyed by component, for db-init to record in
directory_services.image (archived migration 0140). Rendered by the same expression as each workload's own
image:, and a component the chart does not deploy is left out so its row is cleared; Alloy only
when its node_exporter collectors run. check-docs-drift.mjs holds the list equal to 0140's.
*/}}
{{- define "aber.directoryImages" -}}
{{- $v := .Values -}}
{{- $out := dict -}}
{{- $pinned := list
      (list "supabase-studio" $v.supabaseStudio.enabled $v.supabaseStudio.image)
      (list "mosquitto" $v.mosquitto.enabled $v.mosquitto.image)
      (list "grafana" $v.grafana.enabled $v.grafana.image)
      (list "supabase-envoy" $v.supabaseEnvoy.enabled $v.supabaseEnvoy.image)
      (list "supabase-auth" $v.supabaseAuth.enabled $v.supabaseAuth.image)
      (list "supabase-rest" $v.supabaseRest.enabled $v.supabaseRest.image)
      (list "supabase-db" $v.supabaseDb.enabled $v.supabaseDb.image)
      (list "prometheus" $v.observability.enabled $v.observability.prometheus.image)
      (list "alloy" (and $v.observability.enabled $v.observability.alloy.hostMetrics) $v.observability.alloy.image)
      (list "gitea" $v.gitea.enabled $v.gitea.image) -}}
{{- range $pinned -}}
{{- if index . 1 -}}
{{- $image := index . 2 -}}
{{- if not $image.tag -}}
{{- fail (printf "aber.directoryImages: %s has no image tag; an image this repository builds belongs in the built list" (index . 0)) -}}
{{- end -}}
{{- $_ := set $out (index . 0) (printf "%s:%s" $image.repository $image.tag) -}}
{{- end -}}
{{- end -}}
{{- $built := list
      (list "node-red" $v.nodeRed.enabled $v.nodeRed.image)
      (list "supabase-functions" $v.supabaseFunctions.enabled $v.supabaseFunctions.image)
      (list "ingestion" $v.ingestion.enabled $v.ingestion.image)
      (list "timescaledb" $v.timescaledb.enabled $v.timescaledb.image)
      (list "swagger-ui" $v.swaggerUi.enabled $v.swaggerUi.image) -}}
{{- range $built -}}
{{- if index . 1 -}}
{{- $_ := set $out (index . 0) (include "aber.image" (dict "image" (index . 2) "ctx" $)) -}}
{{- end -}}
{{- end -}}
{{- toJson $out -}}
{{- end -}}

{{/*
The Prometheus the Grafana datasource points at: the chart's own when observability.enabled,
otherwise the value, and an empty value fails the render because a datasource pointed at nothing
gives every alert rule DatasourceError against a healthy stack. aber.lokiUrl is the same for Loki.
*/}}
{{- define "aber.prometheusUrl" -}}
{{- if .Values.grafana.prometheusUrl -}}
{{- .Values.grafana.prometheusUrl -}}
{{- else if .Values.observability.enabled -}}
http://prometheus:9090
{{- else -}}
{{- fail "\n\naber: grafana.prometheusUrl is empty and observability.enabled is false.\n\nEither enable the chart's own stack or set grafana.prometheusUrl to the cluster's Prometheus.\n" -}}
{{- end -}}
{{- end -}}

{{/*
The Sparkplug primary host id, validated to one topic level. REQUIRED, WITH NO DEFAULT: every
gateway on site watches spBv1.0/STATE/<id>, so it is part of the contract with equipment this
chart has never seen. The daemon publishes STATE under it and the broker's reconcile grants write
on that one topic from the same value, so the two cannot drift.
*/}}
{{- define "aber.primaryHostId" -}}
{{- $id := .Values.ingestion.primaryHostId | default "" -}}
{{- if not $id -}}
{{- fail "\n\naber: ingestion.primaryHostId is not set.\n\nIt names this site's Sparkplug primary host application. The ingestion daemon publishes a retained\n`online: true` on spBv1.0/STATE/<id> and registers `online: false` as its Last Will, which is how a\nthird-party gateway learns whether its consumer is there -- the broker has granted every gateway\nread of that subtree since the beginning, and nothing published it.\n\nThere is deliberately no default. The id goes into the configuration of every gateway on the site,\nincluding equipment this chart never sees, so it is named once by the deployment:\n\n  --set ingestion.primaryHostId=<a name for this site>\n\nOne topic level: no '/', '+', '#' or whitespace.\n" -}}
{{- end -}}
{{- if regexMatch "[/+#[:space:]]" $id -}}
{{- fail (printf "\n\naber: ingestion.primaryHostId is %q, which is not one topic level.\n\nThe broker grants the ingestion role write on exactly `spBv1.0/STATE/<id>`, so a value containing\n'/', '+', '#' or whitespace publishes where nothing is granted. The broker refuses it, the daemon\ncarries on, and every gateway goes on watching a topic that is never written.\n" $id) -}}
{{- end -}}
{{- $id -}}
{{- end -}}

{{/*
The Sparkplug group id: the second segment of every topic this site publishes, and the enterprise
segment of its Unified Namespace. Fixed at install: the first boot seeds it into the
sparkplug.group_id setting and a later value that differs is refused, because changing it
re-addresses every gateway. Like primaryHostId it has no default: the site names its own.
*/}}
{{- define "aber.sparkplugGroup" -}}
{{- $g := .Values.ingestion.sparkplugGroup | default "" -}}
{{- if not $g -}}
{{- fail "\n\naber: ingestion.sparkplugGroup is not set.\n\nIt is the Sparkplug group id -- the second segment of every topic this site publishes -- and it is\nfixed at the first boot: changing it later re-addresses every gateway and all existing history.\nThere is deliberately no default, so the site names its own:\n\n  --set ingestion.sparkplugGroup=<the group this plant publishes under>\n\nOne topic level: no '/', '+', '#' or whitespace.\n" -}}
{{- end -}}
{{- if regexMatch "[/+#[:space:]]" $g -}}
{{- fail (printf "\n\naber: ingestion.sparkplugGroup is %q, which is not one topic level.\n\nThe group is one segment of `spBv1.0/<group>/<TYPE>/<node>`, and the broker's Directory grant is\nderived from it. A value containing '/', '+', '#' or whitespace addresses a subtree nothing grants,\nand the broker drops the publish silently at QoS 0.\n" $g) -}}
{{- end -}}
{{- $g -}}
{{- end -}}

{{/*
The Directory's MQTT prefix, derived from the group unless a deployment names its own. The
broker's ingestion role is granted <prefix>/# at reconcile time from this same value, so the two
cannot disagree.
*/}}
{{- define "aber.directoryTopicPrefix" -}}
{{- $p := .Values.ingestion.directoryMqttTopicPrefix | default "" -}}
{{- if not $p -}}
{{- $p = printf "%s/Directory/v1" (include "aber.sparkplugGroup" .) -}}
{{- end -}}
{{- $p = trimSuffix "/" $p -}}
{{- if regexMatch "[+#[:space:]]" $p -}}
{{- fail (printf "\n\naber: ingestion.directoryMqttTopicPrefix is %q.\n\nIt becomes the broker grant `<prefix>/#`, so a '+', '#' or whitespace in it either grants a subtree\nnobody meant or matches nothing at all.\n" $p) -}}
{{- end -}}
{{- $p -}}
{{- end -}}

{{- define "aber.lokiUrl" -}}
{{- if .Values.grafana.lokiUrl -}}
{{- .Values.grafana.lokiUrl -}}
{{- else if .Values.observability.enabled -}}
http://loki:3100
{{- else -}}
{{- fail "\n\naber: grafana.lokiUrl is empty and observability.enabled is false.\n\nEither enable the chart's own stack or set grafana.lokiUrl to the cluster's Loki.\n" -}}
{{- end -}}
{{- end -}}

{{/*
Pod annotations that make a workload a scrape target: Alloy keeps every pod carrying
prometheus.io/scrape: "true", reads the port and path from the other two, and labels the series
service with the pod's component. A cluster's own Prometheus reads the same convention.

  {{ include "aber.scrapeAnnotations" (dict "port" 9108 "path" "/metrics") | nindent 8 }}
*/}}
{{- define "aber.scrapeAnnotations" -}}
prometheus.io/scrape: "true"
prometheus.io/port: {{ .port | quote }}
prometheus.io/path: {{ .path | default "/metrics" | quote }}
{{- end -}}

{{/* ======================================================================================== */}}
{{/* 2. Validation. Every check here FAILS THE RENDER: each misconfiguration otherwise produces a stack that reports healthy and refuses every request, or a CrashLoopBackOff whose logs name something other than the cause. */}}
{{/* ======================================================================================== */}}
{{/*
The Supabase credentials are a SET: anonKey and serviceRoleKey are JWTs signed by jwtSecret, and
publishableKey/secretKey are what callers present for the gateway to translate. All supplied or
none; the chart never generates them. Skipped under existingSecret, when the values are not the
chart's to see (kubernetes-architecture.md §3.2).
*/}}
{{- define "aber.validateSecrets" -}}
{{- if not .Values.secrets.existingSecret -}}
{{- $missing := list -}}
{{- range $field, $envName := dict "jwtSecret" "SUPABASE_JWT_SECRET" "anonKey" "SUPABASE_ANON_KEY" "serviceRoleKey" "SUPABASE_SERVICE_ROLE_KEY" "publishableKey" "SUPABASE_PUBLISHABLE_KEY" "secretKey" "SUPABASE_SECRET_KEY" "postgresPassword" "POSTGRES_PASSWORD" -}}
{{- if not (get $.Values.secrets $field) -}}
{{- $missing = append $missing (printf "secrets.%s (%s)" $field $envName) -}}
{{- end -}}
{{- end -}}
{{/*
Grafana is the only consumer of the BI reader password: the maintenance Job reads an empty value as
"do not create the role", and Grafana's datasource initContainer refuses to start without one, so
this is a Helm error rather than a CrashLoopBackOff.
*/}}
{{- if and .Values.grafana.enabled (not .Values.secrets.biReaderPassword) -}}
{{- $missing = append $missing "secrets.biReaderPassword (BI_READER_PASSWORD, required when grafana.enabled)" -}}
{{- end -}}
{{- if and (eq (.Values.ingestion.dbUser | default "") "ingest_writer") (not .Values.secrets.ingestWriterPassword) -}}
{{- $missing = append $missing "secrets.ingestWriterPassword (INGEST_WRITER_PASSWORD, required while ingestion.dbUser is ingest_writer -- the role does not exist without it, and the only other historian credential is the superuser)" -}}
{{- end -}}
{{/*
  The two machine-principal keys: without them helm install reports success while the ingestion
  daemon halts itself rather than run fail-open, and the only symptom is 0 of 1 updated replicas
  are available. Unconditional; neither workload has an enabled flag.
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
The credential service exits 2 on anything shorter than 32 characters rather than running open,
and it is a sidecar in the broker's pod, so the pod never reaches Ready and the rollout error
names i3x-service.
*/}}
{{- if and .Values.gatewayCredential.enabled (lt (len (.Values.secrets.mqttCredentialServiceToken | default "")) 32) -}}
{{- $missing = append $missing "secrets.mqttCredentialServiceToken (MQTT_CREDENTIAL_SERVICE_TOKEN, 32+ characters, required when gatewayCredential.enabled)" -}}
{{- end -}}
{{/*
The plugin's admin: the broker's initContainer exits 1 without it, the same rollout timeout as
above. The credential service authenticates as it; nothing else does.
*/}}
{{- if and .Values.mosquitto.enabled (not .Values.secrets.mqttDynsecAdminPassword) -}}
{{- $missing = append $missing "secrets.mqttDynsecAdminPassword (MQTT_DYNSEC_ADMIN_PASSWORD, required -- the account the credential service administers the broker's Dynamic Security plugin as)" -}}
{{- end -}}
{{/*
Conditional, because playback is off by default: the worker refuses to start without the key and
the CrashLoopBackOff names an env var. mqttPlaybackCredentials is not required beside it: no broker
credential is correct for a stack that has issued no playback targets yet.
*/}}
{{- if and .Values.playback.enabled (not .Values.secrets.playbackKey) -}}
{{- $missing = append $missing "secrets.playbackKey (SUPABASE_PLAYBACK_KEY, required when playback.enabled -- a JWT signed by jwtSecret for subject b0000000-0000-4000-8000-000000000003, Service_Playback)" -}}
{{- end -}}
{{- if $missing -}}
{{- fail (printf "\n\naber: required credentials are not set:\n  - %s\n\nThese are a SET, not independent values: anonKey and serviceRoleKey are JWTs signed by\njwtSecret and publishableKey and secretKey are the keys the gateway translates to them, so\nsupplying some and not others yields a stack that reports healthy and rejects every request\nat the gateway. The chart deliberately does not generate them.\n\nFor a local k3s stack:   helm install ... -f values-dev.yaml\nFor anything else:       copy values-prod.yaml.example and supply a matching set.\n" (join "\n  - " $missing)) -}}
{{- end -}}
{{/*
The demo secret is refused on anything that is not plainly local. values-dev.yaml carries the
published Supabase demo credentials and CI installs with it, so the value alone cannot be banned;
its combination with a public hostname has no innocent reading. node scripts/setup.mjs mints a
matching set.
*/}}
{{- $demoJwtSecret := "super-secret-jwt-token-with-at-least-32-characters" -}}
{{- if eq (.Values.secrets.jwtSecret | default "") $demoJwtSecret -}}
{{- $domain := .Values.global.publicBaseDomain | default "" -}}
{{- $isLocal := or (empty $domain) (contains "127.0.0.1" $domain) (contains "localhost" $domain) (contains "192.168." $domain) (hasSuffix ".local" $domain) (hasSuffix ".localhost" $domain) (hasSuffix ".internal" $domain) -}}
{{- if not $isLocal -}}
{{- fail (printf "\n\naber: refusing to install on the PUBLISHED demo credentials with a public hostname.\n\n  global.publicBaseDomain = %s\n  secrets.jwtSecret       = the Supabase demo value, committed in this repository\n\nanonKey and serviceRoleKey are signed by that secret, so this deployment would authenticate\nanyone holding a file that ships with the source.\n\nGenerate a matching set:\n\n  node scripts/setup.mjs        # writes values-local.yaml with a fresh, internally consistent set\n\nthen install with -f values-local.yaml (or carry the four values into your own values file, see\nvalues-prod.yaml.example), or set\nsecrets.existingSecret to a Secret managed outside the chart.\n\nIf this really is a private lab, name it as one -- a publicBaseDomain under 127.0.0.1.nip.io,\nlocalhost, 192.168.*, .local, .localhost or .internal is accepted as-is.\n" $domain) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Realtime's two keys have lengths enforced by the container (dbEncKey exactly 16, secretKeyBase at
least 64), asserted here so the failure is one Helm error instead of a restarting pod with an
Elixir stack trace. Only when realtime is enabled and the chart owns the secret.
*/}}
{{- define "aber.validateRealtime" -}}
{{- if and .Values.realtime.enabled (not .Values.secrets.existingSecret) -}}
{{- $enc := .Values.secrets.realtimeDbEncKey | default "" -}}
{{- $base := .Values.secrets.realtimeSecretKeyBase | default "" -}}
{{- if ne (len $enc) 16 -}}
{{- fail (printf "\n\naber: secrets.realtimeDbEncKey must be EXACTLY 16 characters (got %d).\nsupabase/realtime refuses to boot otherwise. Generate one with:  openssl rand -hex 8\n" (len $enc)) -}}
{{- end -}}
{{- if lt (len $base) 64 -}}
{{- fail (printf "\n\naber: secrets.realtimeSecretKeyBase must be AT LEAST 64 characters (got %d).\nsupabase/realtime refuses to boot otherwise. Generate one with:  openssl rand -hex 32\n" (len $base)) -}}
{{- end -}}
{{/*
  The third secret realtime refuses to boot without: METRICS_JWT_SECRET is System.fetch_env! as of
  v2.102.3, and the only clue is an Elixir stack trace. No length rule; it only has to exist.
  */}}
{{- if not .Values.secrets.realtimeMetricsJwtSecret -}}
{{- fail "\n\naber: secrets.realtimeMetricsJwtSecret is required (METRICS_JWT_SECRET).\nsupabase/realtime v2.102.3 refuses to boot otherwise. Generate one with:  openssl rand -hex 32\n\nDeliberately NOT secrets.jwtSecret: it signs the bearer token realtime's /metrics endpoint\nrequires, and sharing the API signing key would let anyone holding it mint metrics tokens.\n" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Realtime's Service name must lead with realtime-dev: it reads the tenant from the leading Host
label, which the gateway rewrites to the Service name, so any other name fails every WebSocket
handshake with a bare 403 that names nothing.
*/}}
{{- define "aber.validateRealtimeServiceName" -}}
{{- if .Values.realtime.enabled -}}
{{- $name := .Values.realtime.serviceName | default "" -}}
{{- if not (or (eq $name "realtime-dev") (hasPrefix "realtime-dev." $name)) -}}
{{- fail (printf "\n\naber: realtime.serviceName must be `realtime-dev` (got %q).\n\nRealtime resolves its TENANT from the leading hostname label of the Host header, and\n`realtime-dev` is the tenant SEED_SELF_HOST creates. Any other name makes every WebSocket\nhandshake fail with a bare 403 that does not mention the tenant. See plan §3.4.\n" $name) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
A browser-facing URL resolving to the empty string is worse than a missing one: GoTrue builds
every user-facing redirect from GOTRUE_SITE_URL, so both SSO flows fail at the consent step with
nothing naming the cause, and the registered redirect_uris would be empty too. Gated on
supabaseAuth, because a data-tier-only install needs no domain.
*/}}
{{- define "aber.validatePublicUrls" -}}
{{- if .Values.supabaseAuth.enabled -}}
{{- $missing := list -}}
{{- if not (include "aber.frontendUrl" .) }}{{ $missing = append $missing "frontend (app.<domain>)" }}{{- end -}}
{{- if not (include "aber.supabaseUrl" .) }}{{ $missing = append $missing "supabase (api.<domain>)" }}{{- end -}}
{{- if $missing -}}
{{- fail (printf "\n\naber: no browser-facing URL could be resolved for:\n  - %s\n\nSet global.publicBaseDomain (every host is derived from it), or set publicUrls.* explicitly.\n\nThis is not cosmetic. GoTrue builds every user-facing redirect from GOTRUE_SITE_URL, and an empty\none sends the browser to a path with no origin -- Grafana and Node-RED SSO then fail at the consent\nstep with nothing naming the cause. The OAuth redirect_uris db-init registers would be empty too,\nso no client could ever match one.\n" (join "\n  - " $missing)) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
TLS on the ingress with scheme: http fails as an OAuth error: every browser-facing URL, and so
every registered redirect_uri, is composed from global.scheme, so the browser presents https while
GoTrue holds http. Nothing crashes; only sign-in breaks.
*/}}
{{- define "aber.validateScheme" -}}
{{- if and .Values.ingress.enabled .Values.ingress.tls.enabled (ne .Values.global.scheme "https") -}}
{{- fail (printf "\n\naber: ingress.tls.enabled is true but global.scheme is %q.\n\nEvery browser-facing URL -- and therefore every OAuth redirect_uri db-init registers -- is composed\nfrom global.scheme. With TLS terminating at the ingress the browser arrives over https and presents\nan https redirect_uri, while GoTrue holds the http one: /oauth/authorize answers `invalid\nredirect_uri`, and it reads as a Grafana or Node-RED fault. Grafana's root_url would send users to\nhttp as well, losing the session cookie.\n\nNothing crashes -- only sign-in breaks. Set global.scheme: https.\n" .Values.global.scheme) -}}
{{- end -}}
{{- end -}}

{{/*
An Ingress with empty host: fields is accepted by the API server and then matches every request,
so unrelated traffic reaches the dashboard while no intended hostname routes. Checked here rather
than in ingress.yaml so validation runs in one ordered place.
*/}}
{{- define "aber.validateIngress" -}}
{{- if .Values.ingress.enabled -}}
{{- $hosts := list -}}
{{- range (include "aber.ingressRoutes" . | fromYamlArray) -}}
{{- if .host }}{{ $hosts = append $hosts .host }}{{ end -}}
{{- end -}}
{{- if not $hosts -}}
{{- fail "\n\naber: ingress.enabled is true but no route resolved a hostname.\n\nEvery host is derived from global.publicBaseDomain (or an explicit publicUrls.* entry). With neither\nset this would render an Ingress with empty `host:` fields -- which the API server ACCEPTS, and which\nthen matches EVERY request arriving at the controller, so unrelated traffic reaches the dashboard and\nnone of the intended hostnames route.\n\nSet global.publicBaseDomain, or ingress.enabled=false to run the stack cluster-internal only.\n" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
The single-writer workloads, and why each one is. ONE LIST, READ RATHER THAN RESTATED:
aber.validateAutoscaling and CI's replica/strategy check both parse it (a duplicate once omitted
i3x-service, issue #27). Parsed as YAML: name: reason, continuation lines indented. The key is the
name autoscaling.components takes, unprefixed for the Supabase components.
*/}}
{{- define "aber.singleWriterWorkloads" -}}
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
The workloads that MAY autoscale, and why each is safe to run more than one of. An allow-list
rather than the complement of the block above, because "not single-writer" also admits every name
that does not exist (issue #31).
*/}}
{{- define "aber.autoscalableWorkloads" -}}
supabase-rest: PostgREST is stateless and holds a connection pool per replica
supabase-envoy: the gateway is configured declaratively and holds no state between requests
supabase-functions: the edge runtime is a request router whose workers are per-request isolates
frontend: NGINX serving static files
{{- end -}}

{{/*
An HPA on a workload that must not have one: a single-writer workload, whose damage from scaling
is silent, or a name in neither list, which used to install cleanly and never scale (issues #27
and #31). Forbidden is checked first, so a single-writer workload keeps its own explanation.
*/}}
{{- define "aber.validateAutoscaling" -}}
{{- if .Values.autoscaling.enabled -}}
{{- $single := include "aber.singleWriterWorkloads" . | fromYaml -}}
{{- $forbidden := keys $single -}}
{{- $allowed := keys (include "aber.autoscalableWorkloads" . | fromYaml) -}}
{{- if lt (len $allowed) 4 -}}
{{/*
  The parse trap in the direction that fails closed: an unparseable allow-list would refuse every
  component, the correct four included.
*/}}
{{- fail (printf "\n\naber: the autoscalable workload list did not parse -- got %d entries: %v.\n\nThis guard derives its allow-list from `aber.autoscalableWorkloads` in _helpers.tpl, which\nis read as YAML. Check that block for a broken indent or a stray colon.\n" (len $allowed) $allowed) -}}
{{- end -}}
{{- if lt (len $forbidden) 9 -}}
{{/*
  A parse failure must not read as "nothing is forbidden": fromYaml answers a map carrying an Error
  key rather than failing. A floor rather than an exact count, so adding a workload does not mean
  editing two places.
  */}}
{{- fail (printf "\n\naber: the single-writer workload list did not parse -- got %d entries: %v.\n\nThis guard derives its refusal set from `aber.singleWriterWorkloads` in _helpers.tpl, which\nis read as YAML. An unparseable block would leave the guard EMPTY and every single-writer\nworkload autoscalable, with no error, so it fails here instead. Check that block for a broken\nindent or a stray colon.\n" (len $forbidden) $forbidden) -}}
{{- end -}}
{{- range .Values.autoscaling.components -}}
{{- if has . $forbidden -}}
{{/*
  The component's own reason is printed, not a representative one: the message used to explain
  ingestion whatever had been asked for.
*/}}
{{- fail (printf "\n\naber: autoscaling.components includes %q, which is a SINGLE-WRITER workload.\n\nWhy this one cannot be scaled:\n  %s\n\nRefused rather than warned about, because the damage is SILENT -- no error, no crash, just wrong\ndata or a split fleet. An autoscaler makes that happen under load, which is the worst moment to\ndiscover it.\n\nOnly these may autoscale: %s.\n" . (get $single .) (join ", " $allowed)) -}}
{{- end -}}
{{- if not (has . $allowed) -}}
{{/*
  Issue #31: the name is in neither list, the case that used to render nothing and say nothing.
*/}}
{{- fail (printf "\n\naber: autoscaling.components includes %q, which is not a component this chart can scale.\n\nIt is neither in the allow-list nor among the single-writer workloads, so it would previously have\nrendered NO HPA AND NO ERROR -- indistinguishable from a correct value that happened to produce\nnothing. A typo such as `superbase-rest` installed cleanly and then never scaled, and the symptom\narrived months later under load with nothing logged at install time to search for.\n\nOnly these may autoscale: %s.\n\nIf %q is a real workload that SHOULD scale, add it to `aber.autoscalableWorkloads` in\n_helpers.tpl with the reason it is safe to run more than one of -- and to hpas.yaml's dispatch\ntable, which is checked against that same list.\n" . (join ", " $allowed) .) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Broker TLS: the two ways of asking for a broker nobody can reach, refused because both produce a
stack that reports healthy. (1) external.plaintext false with TLS off is a Service with no ports,
which the API server refuses as spec.ports: Required value, naming neither setting. (2) TLS on
with an external LoadBalancer and no IP or DNS SAN a gateway could match: in-cluster clients
verify, every gateway fails on a hostname mismatch the broker never logs. publicBaseDomain alone
does not satisfy it; an IP SAN or an explicit DNS SAN does.
*/}}
{{- define "aber.validateBrokerTls" -}}
{{- if .Values.mosquitto.enabled -}}
{{- if and .Values.mosquitto.external.enabled (not .Values.mosquitto.external.plaintext) (not .Values.mosquitto.tls.enabled) -}}
{{- fail "\n\naber: mosquitto.external.plaintext=false with mosquitto.tls.enabled=false.\n\nThat asks for an external broker Service with no ports on it at all -- 1883 withdrawn and 8883 never\nadded. The API server would refuse it as `spec.ports: Required value`, which names neither setting.\n\nEither turn TLS on (see deploy/k8s/internal-ca.yaml), or set mosquitto.external.enabled=false if the\nintent is no external broker at all.\n" -}}
{{- end -}}
{{- if and .Values.mosquitto.tls.enabled .Values.mosquitto.external.enabled (eq .Values.mosquitto.external.type "LoadBalancer") -}}
{{- if and (eq (toString .Values.mosquitto.external.loadBalancerIP) "") (not .Values.mosquitto.tls.extraIpSans) (not .Values.mosquitto.tls.extraDnsSans) -}}
{{- fail (printf "\n\naber: broker TLS is on with an external LoadBalancer, but the certificate would carry no\nexternal identity -- no IP SAN and no DNS SAN beyond the in-cluster name.\n\nGateways dial the broker BY ADDRESS; there is rarely plant DNS for it. A certificate with no IP SAN\nfails verification on every gateway while the in-cluster clients -- which connect to `mosquitto` --\nverify perfectly. The stack reports healthy, the host-run gateways keep producing telemetry, and\nthe fleet is silently off.\n\nOnce the cluster has assigned the address:\n\n  kubectl -n %s get svc mosquitto-external -o jsonpath='{.status.loadBalancer.ingress[0].ip}'\n\nthen set ONE of:\n  mosquitto.tls.extraIpSans={<that address>}      # gateways dial the IP (usual case)\n  mosquitto.external.loadBalancerIP=<address>     # pin it, and it is added to the SANs for you\n  mosquitto.tls.extraDnsSans={mqtt.plant.example} # gateways dial a plant DNS name\n" .Release.Namespace)  -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
The gateway MQTT usernames must be well-formed sparkplug_ids, and the monitoring account must have
a password. A friendly username authenticates and then has every message silently dropped, since
the role confines it to spBv1.0/+/+/<username>/# and verify_gateway_binding() requires the same
segment; an empty monitor password leaves the broker permanently NotReady. Skipped under
existingSecret.
*/}}
{{- define "aber.validateMqttPrincipals" -}}
{{- if not .Values.secrets.existingSecret -}}
{{- range $field := list "mqttValidatorUser" -}}
{{- $v := get $.Values.secrets $field -}}
{{- if not (regexMatch "^gwy[0-9a-f]{21}$" $v) -}}
{{- fail (printf "\n\naber: secrets.%s is %q, which is not a gateway sparkplug_id.\n\nIt must be 'gwy' followed by exactly 21 lowercase hex characters. The broker confines a gateway\naccount to `spBv1.0/+/+/<username>/#`, and ingestion's verify_gateway_binding() requires that same\ntopic segment to be the gateway row's GENERATED sparkplug_id -- so any other value AUTHENTICATES\nFINE and then has every published message silently dropped by the broker, with nothing logged at\neither end.\n\nThe id is derived from the row's pinned UUID: 'gwy' + the first 21 hex characters of it.\n  11000000-0000-4000-8000-000000000001 -> gwy110000000000400080000  (validate.py's gateway)\n" $field $v) -}}
{{- end -}}
{{- end -}}
{{- if not .Values.secrets.mqttMonitorPassword -}}
{{- fail "\n\naber: secrets.mqttMonitorPassword is empty.\n\nThe broker's startup, readiness and liveness probes authenticate as this account (it can read\n$SYS and publish nothing). Without it mosquitto never becomes Ready, and every workload that\nwaits on it fails to start -- an outage whose events mention neither MQTT nor this setting.\n" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Publishing Studio requires the credentials that make it a door rather than a hole. With the secrets
unset the gateway substitutes credentials that cannot authenticate and no client is registered, so
the route publishes a hostname whose every request ends at a login nobody can complete, which
reads as a broken proxy rather than two empty values.
*/}}
{{- define "aber.validateStudioRoute" -}}
{{- if and .Values.ingress.enabled (eq (index .Values.ingress.routes "studio") true) -}}
{{- if or (not .Values.secrets.studioOAuthClientSecret) (not .Values.secrets.studioProxyHmacSecret) -}}
{{- fail "\n\naber: ingress.routes.studio is true but Studio's door has no credentials.\n\nThe route publishes the gateway's studio listener, which runs an OAuth flow against this stack's own\nGoTrue and admits `Administrator` only. Without both values below the flow has no registered client\nand no cookie key, so every request to studio.<publicBaseDomain> ends at a login that cannot\ncomplete -- which looks like a broken proxy rather than like an unset value.\n\nSet both:\n  secrets.studioOAuthClientSecret   (also hashed into auth.oauth_clients by migration 0081)\n  secrets.studioProxyHmacSecret     (signs the session cookie; nothing else reads it)\n\nOr leave ingress.routes.studio at its default of false and reach the console with a port-forward.\n" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
A Secure-cookie login published over plain http on a host a browser will not keep the cookie for:
Envoy's oauth2 filter sets every cookie Secure, which a browser keeps only on https or on
localhost, so the callback arrives holding no state and answers 401 CSRF token validation failed.
The URL is judged, not global.scheme, because a publicUrls.* override carries its own scheme.
*/}}
{{- define "aber.validateSecureCookieRoutes" -}}
{{- if .Values.ingress.enabled -}}
{{- range (include "aber.ingressRoutes" . | fromYamlArray) -}}
{{- if and (or (eq .name "studio") (eq .name "gitea")) (ne (index $.Values.ingress.routes .name) false) -}}
{{- $url := include (printf "aber.%sUrl" .name) $ -}}
{{- if and (hasPrefix "http://" $url) (not (or (eq .host "localhost") (hasSuffix ".localhost" .host))) -}}
{{- fail (printf "\n\naber: ingress.routes.%s is published at %s, where its login cannot complete.\n\nThe %s listener signs in through Envoy's oauth2 filter, which sets every cookie it uses with the\nSecure attribute. A browser keeps those only on an https origin or on localhost / *.localhost; on\nthis host the callback arrives holding no state and answers 401 `CSRF token validation failed`.\nNothing crashes -- the door never opens.\n\nOne of:\n  global.scheme: https with ingress.tls.enabled (or a TLS terminator in front of the ingress)\n  a *.localhost domain on a single machine, e.g. global.publicBaseDomain: localhost\n  ingress.routes.%s: false, and reach it with a port-forward\n" .name $url .name .name) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Single entry point, included once from NOTES.txt so every render runs every check. Order is
deliberate, most fundamental first: a stack with no credentials is told that, not about the
hostnames it also lacks.
*/}}
{{- define "aber.validate" -}}
{{- include "aber.validateSecrets" . -}}
{{- include "aber.validateStudioRoute" . -}}
{{- include "aber.validateMqttPrincipals" . -}}
{{- include "aber.validateRealtime" . -}}
{{- include "aber.validateRealtimeServiceName" . -}}
{{- include "aber.validatePublicUrls" . -}}
{{- include "aber.validateScheme" . -}}
{{- include "aber.validateIngress" . -}}
{{- include "aber.validateSecureCookieRoutes" . -}}
{{- include "aber.validateBrokerTls" . -}}
{{- include "aber.validateAutoscaling" . -}}
{{- include "aber.validateCapacity" . -}}
{{- include "aber.validatePhysicalBackup" . -}}
{{- end -}}

{{/*
Broker client transport, shared by the ingestion daemon, i3X, Node-RED, playback and the e2e
validator. Defined once because all five read the same variable names against one contract, so a
port set for one and not another is unrepresentable.
*/}}
{{- define "aber.brokerClientEnv" -}}
{{- $tls := .Values.mosquitto.tls -}}
- name: MQTT_HOST
  value: mosquitto
{{- if and $tls.enabled $tls.internalClients }}
- name: MQTT_PORT
  value: "8883"
- name: MQTT_TLS_ENABLED
  value: "true"
{{- /*
       Projected from the broker's certificate Secret; aber.brokerClientCaVolume says why only ca.crt.
       */}}
- name: MQTT_TLS_CA_FILE
  value: /etc/aber/broker-ca/ca.crt
{{- else }}
- name: MQTT_PORT
  value: "1883"
{{- end }}
{{- end -}}

{{/*
The CA-only projection of the broker certificate Secret. Only ca.crt is projected: the
kubernetes.io/tls Secret also holds tls.key, the broker's private key, and items restricts the
projection at the kubelet so the key is never written into a client pod's filesystem.
*/}}
{{- define "aber.brokerClientCaVolume" -}}
- name: broker-ca
  secret:
    secretName: {{ .Values.mosquitto.tls.secretName }}
    defaultMode: 0444
    items:
      - key: ca.crt
        path: ca.crt
{{- end -}}

{{- define "aber.brokerClientCaMount" -}}
- name: broker-ca
  mountPath: /etc/aber/broker-ca
  readOnly: true
{{- end -}}

{{/* ======================================================================================== */}}
{{/* 3. Connection strings. Written once; every one targets the in-cluster Service name and the standard port, never a published port. */}}
{{/* ======================================================================================== */}}
{{/*
M2. TimescaleDB is reached at timescaledb:5432, never the host-published 5433, which exists only
to keep the dev loop's forwarded port off a developer's local PostgreSQL. A wrong port in the
baseline schema's postgres_fdw server reads as a schema fault; helm test (M6) pins it.
*/}}
{{- define "aber.timescale.host" -}}timescaledb{{- end -}}
{{- define "aber.timescale.port" -}}5432{{- end -}}

{{- define "aber.supabaseDb.host" -}}supabase-db{{- end -}}
{{- define "aber.supabaseDb.port" -}}5432{{- end -}}

{{/*
The gateway as reached from inside the cluster. The browser-facing address is publicUrls.supabase.
*/}}
{{- define "aber.supabase.internalUrl" -}}http://supabase-envoy:8000{{- end -}}

{{/* ======================================================================================== */}}
{{/* TLS to the databases (postgresTls). One issuer for both, so one CA verifies either; clients project ca.crt alone, since the Secret also holds the server's key. */}}
{{/* ======================================================================================== */}}
{{- define "aber.dbTlsSecretName" -}}{{ printf "%s-tls" . }}{{- end -}}
{{- define "aber.dbCaSecretName" -}}
{{- ternary "supabase-db-tls" "timescaledb-tls" .Values.supabaseDb.enabled -}}
{{- end -}}
{{- define "aber.dbCaPath" -}}/etc/aber/db-ca/ca.crt{{- end -}}

{{/*
Each of these renders nothing while TLS is off, so a caller adds them to an existing list
unconditionally and only wraps a list that would otherwise be empty.
*/}}
{{- define "aber.dbClientCaVolume" -}}
{{- if .Values.postgresTls.enabled }}
- name: db-ca
  secret:
    secretName: {{ include "aber.dbCaSecretName" . }}
    defaultMode: 0444
    items:
      - key: ca.crt
        path: ca.crt
{{- end }}
{{- end -}}

{{- define "aber.dbClientCaMount" -}}
{{- if .Values.postgresTls.enabled }}
- name: db-ca
  mountPath: /etc/aber/db-ca
  readOnly: true
{{- end }}
{{- end -}}

{{/*
libpq's own variables, which psql, pg_dump, psycopg2 and PostgREST all read; absent, libpq
negotiates nothing and the server offers nothing.
*/}}
{{- define "aber.dbClientTlsEnv" -}}
{{- if .Values.postgresTls.enabled }}
- name: PGSSLMODE
  value: verify-full
- name: PGSSLROOTCERT
  value: {{ include "aber.dbCaPath" . }}
{{- end }}
{{- end -}}

{{/*
The DSN tail for the clients that spell the mode in their URL (GoTrue, PostgREST).
*/}}
{{- define "aber.dsnSslParams" -}}
{{- if .Values.postgresTls.enabled -}}
sslmode=verify-full&sslrootcert={{ include "aber.dbCaPath" . }}
{{- else -}}
sslmode=disable
{{- end -}}
{{- end -}}

{{/*
The CA as PEM in an environment variable, which is how storage-api and postgres-meta take it.
Usage: (dict "ctx" . "name" "DATABASE_SSL_ROOT_CERT")
*/}}
{{- define "aber.dbCaPemEnv" -}}
{{- if .ctx.Values.postgresTls.enabled }}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ include "aber.dbCaSecretName" .ctx }}
      key: ca.crt
{{- end }}
{{- end -}}

{{/*
The certificate reload sidecar for a database pod. cert-manager renews the leaf in place and
nothing restarts a StatefulSet for it; Postgres re-reads its certificate on a reload, so this
watches the mounted certificate and asks for one over loopback, which pg_hba trusts.
Usage: (dict "ctx" . "image" "<repo:tag>" "pullPolicy" "IfNotPresent" "user" "postgres" "db" "postgres")
*/}}
{{- define "aber.dbCertificateReload" -}}
- name: certificate-reload
  image: {{ .image | quote }}
  imagePullPolicy: {{ .pullPolicy }}
  command:
    - /bin/sh
    - -c
    - |
      lastcert=$(md5sum < /etc/aber/postgres/tls/tls.crt)
      while :; do
        sleep {{ .ctx.Values.postgresTls.watchIntervalSeconds }}
        nowcert=$(md5sum < /etc/aber/postgres/tls/tls.crt)
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
      mountPath: /etc/aber/postgres/tls
      readOnly: true
  resources:
    requests: { cpu: 10m, memory: 16Mi }
    limits: { memory: 64Mi }
{{- end -}}

{{/*
The postgres_exporter sidecar for both database pods; db names the component (the job label),
database the database it connects to. THE DSN CARRIES NO PASSWORD AND NO sslmode: metrics_reader
has none and can authenticate only from loopback, which is the argument for its pg_monitor, and
without sslmode libpq's prefer negotiates TLS when postgresTls is on and plaintext when off, so one
DSN is correct under both. NO READINESS PROBE, deliberately: a readinessProbe on any container
gates the whole pod's Service endpoints, and a metrics sidecar must never be able to take the
database out of service. Whether it works is the scrape's question.
*/}}
{{- define "aber.dbMetricsExporter" -}}
{{- $m := .ctx.Values.databaseMetrics -}}
- name: metrics
  image: "{{ $m.image.repository }}:{{ $m.image.tag }}"
  imagePullPolicy: {{ $m.image.pullPolicy }}
  args:
    - --web.listen-address=:{{ $m.port }}
    {{- /* Argued in values.yaml, with the series counts that decided it. */}}
    - --no-collector.settings
    - --no-collector.stat_user_tables
    - --no-collector.statio_user_tables
    {{- if $m.statementStats }}
    {{- /*
           Off by default in the exporter because the extension may not be there; it is, on both. Bounded
           at the exporter's own top-100, and labelled by queryid, not the statement text.
           */}}
    - --collector.stat_statements
    {{- end }}
    {{- /*
      Two collectors the exporter leaves off, each on for a specific reader: database_wraparound
      (age(datfrozenxid), the only warning of transaction-ID exhaustion; 4 series) and
      stat_checkpointer (PG17 moved the checkpoint counters out of pg_stat_bgwriter; 11 series). 255
      series to 272 on the historian. The wraparound series' _seconds suffix is an upstream misnomer
      for a transaction count, verified, and the alert rule says so too.
    */}}
    - --collector.database_wraparound
    - --collector.stat_checkpointer
    {{- /*
           The custom queries: deprecated upstream and functional, v0.20.1 says so at startup;
           files/database-exporter/common.yaml records the fallback.
           */}}
    - --extend.query-path=/etc/postgres-exporter/queries.yaml
    {{- range $m.extraArgs }}
    - {{ . | quote }}
    {{- end }}
  env:
    - name: DATA_SOURCE_NAME
      value: postgresql://metrics_reader@127.0.0.1:5432/{{ .database }}
  ports:
    - name: metrics
      containerPort: {{ $m.port }}
      protocol: TCP
  volumeMounts:
    - name: exporter-queries
      mountPath: /etc/postgres-exporter
      readOnly: true
  resources:
    {{- toYaml $m.resources | nindent 4 }}
{{- end -}}

{{/*
The server-side settings, as -c flags appended to each image's own command.
*/}}
{{- define "aber.dbTlsServerArgs" -}}
- -c
- ssl=on
- -c
- ssl_cert_file=/etc/aber/postgres/tls/tls.crt
- -c
- ssl_key_file=/etc/aber/postgres/tls/tls.key
- -c
- hba_file=/etc/aber/postgres/pg_hba.conf
{{- end -}}

{{/*
The server-side mounts and volumes. tls is the cert-manager Secret, 0440 so the key is
group-readable by the database user and world-readable by nobody; hba is the chart's pg_hba.conf.
*/}}
{{- define "aber.dbTlsServerMounts" -}}
- name: tls
  mountPath: /etc/aber/postgres/tls
  readOnly: true
- name: hba
  mountPath: /etc/aber/postgres/pg_hba.conf
  subPath: {{ printf "%s.pg_hba.conf" .db }}
  readOnly: true
{{- end -}}

{{- define "aber.dbTlsServerVolumes" -}}
- name: tls
  secret:
    secretName: {{ include "aber.dbTlsSecretName" .db }}
    defaultMode: 0440
- name: hba
  configMap:
    name: {{ printf "%s-postgres-tls" (include "aber.fullname" .ctx) }}
{{- end -}}

{{/*
DSN builder. The password is urlquery-escaped: one containing @ or / silently truncates the DSN
and the failure reads as a bad hostname.
  {{ include "aber.dsn" (dict "user" "authenticator" "password" $pw "host" "supabase-db" "port" 5432 "db" "postgres" "params" (include "aber.dsnSslParams" .)) }}
*/}}
{{- define "aber.dsn" -}}
{{- $params := .params | default "" -}}
{{- printf "postgres://%s:%s@%s:%v/%s%s" .user (urlquery .password) .host .port .db (ternary (printf "?%s" $params) "" (ne $params "")) -}}
{{- end -}}

{{/* ======================================================================================== */}}
{{/* 4. Environment blocks */}}
{{/* ======================================================================================== */}}
{{/*
Browser-facing URLs, each falling back to <sub>.<publicBaseDomain> so a deployment sets one value.
NEVER THE IN-CLUSTER ADDRESS: auth_url is followed by the browser, token_url and userinfo are
called by the container, and using one for both fails in a way that names neither. In-cluster
URLs are constants.
*/}}
{{- define "aber.publicUrl" -}}
{{- $explicit := index .ctx.Values.publicUrls .key -}}
{{- if $explicit -}}
{{- $explicit | trimSuffix "/" -}}
{{- else if .ctx.Values.global.publicBaseDomain -}}
{{- printf "%s://%s.%s" .ctx.Values.global.scheme .sub .ctx.Values.global.publicBaseDomain -}}
{{- end -}}
{{- end -}}

{{- define "aber.frontendUrl" -}}{{ include "aber.publicUrl" (dict "ctx" . "key" "frontend" "sub" "app") }}{{- end -}}
{{- define "aber.supabaseUrl" -}}{{ include "aber.publicUrl" (dict "ctx" . "key" "supabase" "sub" "api") }}{{- end -}}
{{- define "aber.grafanaUrl" -}}{{ include "aber.publicUrl" (dict "ctx" . "key" "grafana" "sub" "grafana") }}{{- end -}}
{{- define "aber.noderedUrl" -}}{{ include "aber.publicUrl" (dict "ctx" . "key" "nodered" "sub" "nodered") }}{{- end -}}
{{- define "aber.studioUrl" -}}{{ include "aber.publicUrl" (dict "ctx" . "key" "studio" "sub" "studio") }}{{- end -}}
{{- define "aber.docsUrl" -}}{{ include "aber.publicUrl" (dict "ctx" . "key" "docs" "sub" "docs") }}{{- end -}}
{{- define "aber.mqttUrl" -}}{{ include "aber.publicUrl" (dict "ctx" . "key" "mqtt" "sub" "mqtt") }}{{- end -}}

{{/*
The browser origins the gateway echoes, as a JSON array for __CORS_ORIGINS__. DERIVED, NOT
CONFIGURED: this is the stack's only statement of origin policy (the edge functions carry none),
built from the dashboard's and Swagger UI's own URL helpers so it cannot name a host the chart does
not serve or miss one it does; corsExtraOrigins is appended for what the chart cannot know. Empty
is refused: origins: [] is a gateway that starts and refuses every browser request.
*/}}
{{- define "aber.corsOrigins" -}}
{{- $origins := list -}}
{{- $frontend := include "aber.frontendUrl" . -}}
{{- if $frontend -}}{{- $origins = append $origins $frontend -}}{{- end -}}
{{- $docs := include "aber.docsUrl" . -}}
{{- if $docs -}}{{- $origins = append $origins $docs -}}{{- end -}}
{{- range .Values.global.corsExtraOrigins -}}
{{- $origins = append $origins (. | trimSuffix "/") -}}
{{- end -}}
{{/*
Refused only when there is something to refuse for: an install with no public surface is already
refused, more specifically, by the URL and hostname guards, and failing here first would mask
them. CI's guard-rail suite asserts each guard's own message.
*/}}
{{- if and (not $origins) (include "aber.supabaseUrl" .) -}}
{{- fail "\n\naber: the gateway would be given an EMPTY browser-origin list.\n\npublicUrls.supabase names a browser-facing API, but no origin could be derived for the\ndashboard or for Swagger UI -- so the gateway would start cleanly and then refuse every browser\nrequest to it, returning 200 with no Access-Control-Allow-Origin. That presents as a\ndashboard which signs in and then shows empty tables, with nothing failing anywhere you\nwould think to look.\n\nSet global.publicBaseDomain, or publicUrls.frontend / publicUrls.docs, or\nglobal.corsExtraOrigins if this deployment is reached only through a proxy whose hostname\nthe chart cannot derive.\n" -}}
{{- end -}}
{{- $origins | uniq | toJson -}}
{{- end -}}
{{/*
The i3X server's URL, derived like the others because it has several consumers: the Ingress rule,
NOTES.txt, and I3X_BASE_URL for the conformance suite and the MCP server.
*/}}
{{- define "aber.i3xUrl" -}}{{ include "aber.publicUrl" (dict "ctx" . "key" "i3x" "sub" "i3x") }}{{- end -}}

{{/*
The forge's URL, derived like the others. Gitea's ROOT_URL prints it as the clone command, so the
address an engineer copies cannot disagree with the address the Ingress routes.
*/}}
{{- define "aber.giteaUrl" -}}{{ include "aber.publicUrl" (dict "ctx" . "key" "gitea" "sub" "git") }}{{- end -}}

{{/*
Host only, for an Ingress rule. host is a DNS name and rejects a scheme; a URL there yields a rule
matching nothing, accepted, failing as a 404 from the controller's default backend.
*/}}
{{- define "aber.hostOf" -}}
{{- $url := include (printf "aber.%sUrl" .name) .ctx -}}
{{- if $url -}}
{{- regexReplaceAll "^[a-z]+://" $url "" | splitList "/" | first -}}
{{- end -}}
{{- end -}}

{{/*
Every ingress route in one place: subdomain, backend Service, port, and whether it is deployed.
Read by ingress.yaml, NOTES.txt and the NetworkPolicies, so the public surface has one definition.
*/}}
{{- define "aber.ingressRoutes" -}}
{{- $routes := list -}}
{{- if .Values.frontend.enabled -}}
{{- $routes = append $routes (dict "name" "frontend" "host" (include "aber.hostOf" (dict "ctx" . "name" "frontend")) "service" "frontend" "port" 3000) -}}
{{- end -}}
{{- if .Values.supabaseEnvoy.enabled -}}
{{- $routes = append $routes (dict "name" "supabase" "host" (include "aber.hostOf" (dict "ctx" . "name" "supabase")) "service" "supabase-envoy" "port" 8000) -}}
{{- end -}}
{{- if .Values.nodeRed.enabled -}}
{{- $routes = append $routes (dict "name" "nodered" "host" (include "aber.hostOf" (dict "ctx" . "name" "nodered")) "service" "node-red" "port" 1880) -}}
{{- end -}}
{{- if .Values.grafana.enabled -}}
{{- $routes = append $routes (dict "name" "grafana" "host" (include "aber.hostOf" (dict "ctx" . "name" "grafana")) "service" "grafana" "port" 3000) -}}
{{- end -}}
{{/*
     Studio is published through the gateway, never directly, and this line is the whole control:
     supabase-studio:3000 is a database console with no login running as the owner, and the gateway's
     studio listener on 8001 is the same console behind an OAuth flow and an Administrator check.
     Gated on the gateway too, so the route is absent rather than pointed somewhere unauthenticated.
     */}}
{{- if and .Values.supabaseStudio.enabled .Values.supabaseEnvoy.enabled -}}
{{- $routes = append $routes (dict "name" "studio" "host" (include "aber.hostOf" (dict "ctx" . "name" "studio")) "service" "supabase-envoy" "port" 8001) -}}
{{- end -}}
{{- if .Values.swaggerUi.enabled -}}
{{- $routes = append $routes (dict "name" "docs" "host" (include "aber.hostOf" (dict "ctx" . "name" "docs")) "service" "swagger-ui" "port" 8080) -}}
{{- end -}}
{{- if .Values.i3xService.enabled -}}
{{/*
     i3X is browser- and client-facing (the MCP server, the Explorer, conformance runs), so it needs a
     route of its own. GET /info is unauthenticated by spec and exposes a capabilities document, which
     is intended and is why nothing about the address space is in it.
     */}}
{{- $routes = append $routes (dict "name" "i3x" "host" (include "aber.hostOf" (dict "ctx" . "name" "i3x")) "service" "i3x-service" "port" 8090) -}}
{{- end -}}
{{- if and .Values.gitea.enabled .Values.supabaseEnvoy.enabled -}}
{{/*
     The web half of the forge only, through the gateway's forge listener (8002), and this line is the
     whole control: Gitea signs in whoever X-WEBAUTH-USER names, from any peer (measured), so a route
     naming gitea:3000 would let a request choose its own identity. Git over SSH is gitea-external's.
     */}}
{{- $routes = append $routes (dict "name" "gitea" "host" (include "aber.hostOf" (dict "ctx" . "name" "gitea")) "service" "supabase-envoy" "port" 8002) -}}
{{- end -}}
{{- if .Values.mosquitto.enabled -}}
{{/*
     MQTT over WebSockets only, port 9001. Raw MQTT is TCP and cannot ride an HTTP Ingress; that is
     mosquitto-external.
     */}}
{{- $routes = append $routes (dict "name" "mqtt" "host" (include "aber.hostOf" (dict "ctx" . "name" "mqtt")) "service" "mosquitto" "port" 9001) -}}
{{- end -}}
{{- toYaml $routes -}}
{{- end -}}

{{/*
Wait-for initContainer. Kubernetes has no depends_on, so these loops make ordering explicit and
leave the pod in Init: with a legible reason; bounded, because an unbounded wait is Init: forever
with nothing to alert on. command and describe are REQUIRED and the render fails without them:
omitting them produced `until ; do`, valid YAML holding a shell syntax error that helm lint, helm
template and kubeconform all passed.
  (dict "ctx" $ "name" "wait-for-db" "command" "<shell test>" "describe" "supabase-db")
*/}}
{{- define "aber.waitFor" -}}
{{- if not .command }}{{- fail (printf "aber.waitFor(%s): `command` is required. It is the shell test the until-loop runs; without it the container renders as `until ; do` and dies with a shell syntax error at runtime instead of failing here." (.name | default "<unnamed>")) }}{{- end }}
{{- if not .describe }}{{- fail (printf "aber.waitFor(%s): `describe` is required. It is what the pod prints while waiting and on timeout, and it is the only thing that makes an Init: pod legible." (.name | default "<unnamed>")) }}{{- end }}
- name: {{ .name | required "aber.waitFor: `name` is required (it names the initContainer in kubectl output)." }}
  image: {{ .image | default "busybox:1.36" }}
  imagePullPolicy: IfNotPresent
  {{- /*
         Optional env, for a probe that needs a credential, passed as rendered YAML so no secret value
         reaches a command line where kubectl describe would show it.
         */ -}}
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
Wait for a Postgres to accept a QUERY, not merely a connection: pg_isready answers during
supabase/postgres's own bootstrap while queries are still refused. Optional query waits for a
schema rather than a server, since psql -c exits non-zero on a missing relation exactly as on a
refused connection; optional describe names what is waited for.
*/}}
{{- define "aber.waitForPostgres" -}}
- name: {{ .name }}
  image: "{{ .ctx.Values.supabaseDb.image.repository }}:{{ .ctx.Values.supabaseDb.image.tag }}"
  imagePullPolicy: {{ .ctx.Values.supabaseDb.image.pullPolicy }}
  env:
    - name: PGPASSWORD
      valueFrom:
        secretKeyRef:
          name: {{ include "aber.secretName" .ctx }}
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

{{/*
One key from the chart's Secret as an env var.
*/}}
{{- define "aber.secretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ .secretName }}
      key: {{ .key }}
{{- end -}}

{{/*
The same with optional: true, for a key the Secret may not carry. A second helper rather than a
flag so the default stays fail-closed: a container that boots without its credential fails later,
further away, and reads as a broken upstream.
*/}}
{{- define "aber.optionalSecretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ .secretName }}
      key: {{ .key }}
      optional: true
{{- end -}}

{{/*
The MQTT principals the chart provisions, as env for the broker's assemble-config initContainer;
the set must match PLATFORM_PRINCIPALS in scripts/lib/mosquitto-dynsec.mjs. An empty password
skips that account (the validator is a fixture a production install leaves unset). Consumers take
only their own pair, so this is deliberately not used there.
*/}}
{{- define "aber.mqttPrincipals" -}}
INGESTION I3X VALIDATOR MONITOR
{{- end -}}

{{- define "aber.mqttPrincipalEnv" -}}
{{- $secretName := include "aber.secretName" . -}}
{{- range $p := splitList " " (include "aber.mqttPrincipals" .) }}
{{ include "aber.secretEnv" (dict "name" (printf "MQTT_%s_USER" $p) "secretName" $secretName "key" (printf "MQTT_%s_USER" $p)) }}
{{ include "aber.secretEnv" (dict "name" (printf "MQTT_%s_PASSWORD" $p) "secretName" $secretName "key" (printf "MQTT_%s_PASSWORD" $p)) }}
{{- end }}
{{- end -}}

{{/*
Node-RED authentication environment, one definition included in two places and load-bearing for
that: the container and its init container must receive it identically, because node-red-init.mjs
evaluates the settings.js it wrote, which resolves every value from process.env, and a value absent
when read makes the settings look wrong and get rewritten on every boot, silently.
*/}}
{{- define "aber.noderedAuthEnv" -}}
{{- $secretName := include "aber.secretName" . -}}
{{- $nodered := .Values.publicUrls.nodered | default (printf "%s://nodered.%s" .Values.global.scheme .Values.global.publicBaseDomain) -}}
{{- $supabase := .Values.publicUrls.supabase | default (printf "%s://api.%s" .Values.global.scheme .Values.global.publicBaseDomain) -}}
{{ include "aber.secretEnv" (dict "name" "NODERED_CREDENTIAL_SECRET" "secretName" $secretName "key" "NODERED_CREDENTIAL_SECRET") }}
{{ include "aber.secretEnv" (dict "name" "NODERED_OAUTH_CLIENT_SECRET" "secretName" $secretName "key" "NODERED_OAUTH_CLIENT_SECRET") }}
{{ include "aber.secretEnv" (dict "name" "NODERED_WEBHOOK_JWT_SECRET" "secretName" $secretName "key" "NODERED_WEBHOOK_JWT_SECRET") }}
{{ include "aber.secretEnv" (dict "name" "NODERED_ADMIN_TOKEN" "secretName" $secretName "key" "NODERED_ADMIN_TOKEN") }}
{{ include "aber.secretEnv" (dict "name" "SUPABASE_JWT_SECRET" "secretName" $secretName "key" "SUPABASE_JWT_SECRET") }}
{{ include "aber.secretEnv" (dict "name" "SUPABASE_PUBLISHABLE_KEY" "secretName" $secretName "key" "SUPABASE_PUBLISHABLE_KEY") }}
- name: NODERED_OAUTH_CLIENT_ID
  value: {{ .Values.nodeRed.oauthClientId | default "c0ffee00-0000-4000-8000-000000000002" | quote }}
{{/*
     auth_url is followed by the browser, so it is the ingress address; token_url and userinfo are
     called by the container, so they are in-cluster.
     */}}
- name: NODERED_OAUTH_AUTH_URL
  value: {{ printf "%s/auth/v1/oauth/authorize" $supabase | quote }}
- name: NODERED_OAUTH_TOKEN_URL
  value: {{ printf "%s/auth/v1/oauth/token" (include "aber.supabase.internalUrl" .) | quote }}
- name: NODERED_USERINFO_URL
  value: {{ printf "%s/functions/v1/nodered-userinfo" (include "aber.supabase.internalUrl" .) | quote }}
{{/*
     Must match redirect_uris in auth.oauth_clients exactly; both are built from publicUrls.nodered so
     they cannot drift.
     */}}
- name: NODERED_OAUTH_CALLBACK_URL
  value: {{ printf "%s/auth/strategy/callback" $nodered | quote }}
{{- end -}}

{{/*
Kubernetes quantity parsers, which Helm lacks. The capacity guard compares strings from .Values
("100m", "256Mi") and the kubelet's status.allocatable ("16", "15890m", "...Ki"); integers,
millicores and bytes, so the comparison never touches floating point.
*/}}
{{- define "aber.cpuMillis" -}}
{{- $v := . | toString -}}
{{- if hasSuffix "m" $v -}}
{{- trimSuffix "m" $v | float64 | int64 -}}
{{- else -}}
{{- mulf ($v | float64) 1000.0 | int64 -}}
{{- end -}}
{{- end -}}

{{- define "aber.memBytes" -}}
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
The chart's scheduling floor: the sum of the requests it will ask for, as "<millicores> <bytes>".
Derived from .Values rather than written down, since a floor edited in a second place is wrong,
and wrong high refuses an install that would have worked. Counted: every continuously running,
enabled component, times its replicas. Not counted: Jobs and CronJobs, and init containers, since
a pod's effective request is max(init, sum(containers)).
*/}}
{{- define "aber.requestFloor" -}}
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
{{- $cpu = add $cpu (mul (include "aber.cpuMillis" $req.cpu | int64) $n) -}}
{{- end -}}
{{- if $req.memory -}}
{{- $mem = add $mem (mul (include "aber.memBytes" $req.memory | int64) $n) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- printf "%d %d" $cpu $mem -}}
{{- end -}}

{{/*
Refuses an install onto a cluster that cannot schedule the stack; otherwise helm install reports
success and the pods sit Pending forever with nothing in any container log. Four things it
deliberately does not do, each erring towards allowing a tight install: not on upgrade (a running
stack has proved it fits); nothing when lookup returns nothing (helm template, --dry-run, a
credential that may not list nodes); no exclusion of tainted nodes (the databases accept
tolerations); no multiplying the DaemonSet by the node count.
*/}}
{{- define "aber.validateCapacity" -}}
{{/*
  .Release.IsInstall is tested first and preflight is read through default dict: helm upgrade
  --reuse-values replays the previous revision's stored values, which for a release installed before
  this guard exists has no preflight key, and reading it directly is a nil-pointer panic at
  NOTES.txt naming interface{} and nothing about capacity.
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
{{- $cpu = add $cpu (include "aber.cpuMillis" $alloc.cpu | int64) -}}
{{- $mem = add $mem (include "aber.memBytes" $alloc.memory | int64) -}}
{{- end -}}
{{- end -}}
{{- $floor := splitList " " (include "aber.requestFloor" $) -}}
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
{{- fail (printf "\n\naber: this cluster cannot schedule the stack.\n\nAcross %d schedulable node(s):\n\n  %s\n\nThese are REQUESTS, not usage. A request is a reservation the scheduler must satisfy before it\nwill place a pod at all, so the shortfall does not make the stack slow -- it leaves pods Pending\nindefinitely, with nothing in any container log to say why, because no container starts. Refused\nhere rather than discovered there.\n\nThe documented minimum is 4 vCPU and 8 GiB on one node, measured rather than estimated:\ndeploy/k8s/README.md, Prerequisites -> Hardware.\n\nEither give the cluster more room, or lower what the chart asks for -- every component's\n`resources.requests` is a value, and this floor is derived from them, so reducing them reduces\nthis number too. Turning components off (grafana.enabled, gitea.enabled, observability.enabled)\nlowers it as well.\n\nTo install anyway and accept Pending pods:  --set preflight.capacityCheck=false\n" $counted (join "\n  " $short)) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
The ingress rule for git over SSH on the Gitea pod, shared by the always-on forge policy and the M4
layer so the two cannot disagree. At the default it emits no from at all rather than ipBlock
0.0.0.0/0: a rule with no peers matches every source in every CNI, whereas an ipBlock is matched
against an address, which a CNI resolving node traffic by identity need not do, and covers no
IPv6; appliance traffic arrives SNAT'd by ServiceLB. (deploy/k8s/README.md, "NetworkPolicies (M4)")
*/}}
{{- define "aber.giteaSshIngressRule" -}}
{{- $cidrs := .Values.networkPolicy.giteaSshAllowedCidrs | default list -}}
{{- if or (empty $cidrs) (has "0.0.0.0/0" $cidrs) -}}
- ports:
    - protocol: TCP
      port: 22
{{- else -}}
- from:
    {{- range $cidrs }}
    - ipBlock:
        cidr: {{ . | quote }}
    {{- end }}
  ports:
    - protocol: TCP
      port: 22
{{- end -}}
{{- end -}}

{{/*
The historian's raw retention window, timescaledb.retention.retainFor; an empty value stored by an
older chart means the 14-day default. Archiving is not consulted: retention.sql's job protects
unverified chunks while it is on.
*/}}
{{- define "aber.timescaleRetainFor" -}}
{{- .Values.timescaledb.retention.retainFor | default "14 days" -}}
{{- end -}}

{{/*
The raw hypertable's chunk span: timescaledb.retention.chunkInterval, or derived from
expectedRowsPerDay as a quarter of the historian's memory limit at 367 bytes a row, in whole hours
clamped to 1 hour .. 7 days, whole days written as days. Values stored by an older chart have no
expectedRowsPerDay and keep the 7 days they ran with.
*/}}
{{- define "aber.timescaleChunkInterval" -}}
{{- $r := .Values.timescaledb.retention -}}
{{- if $r.chunkInterval -}}
{{- $r.chunkInterval -}}
{{- else if not (hasKey $r "expectedRowsPerDay") -}}
7 days
{{- else -}}
{{- $rows := $r.expectedRowsPerDay | float64 -}}
{{- if le $rows 0.0 -}}
{{- fail (printf "\n\naber: timescaledb.retention.expectedRowsPerDay is %v. It sizes the historian's chunks and must be\npositive: devices x metrics x samples per metric a day. Or set timescaledb.retention.chunkInterval.\n" $r.expectedRowsPerDay) -}}
{{- end -}}
{{- $res := .Values.timescaledb.resources | default dict -}}
{{- $mem := (($res.limits | default dict).memory) | default (($res.requests | default dict).memory) -}}
{{- if not $mem -}}
{{- fail "\n\naber: timescaledb.resources sets no memory limit or request, so the chunk interval cannot be derived.\nSet timescaledb.retention.chunkInterval.\n" -}}
{{- end -}}
{{- $rowsPerChunk := divf (divf (include "aber.memBytes" $mem | float64) 4.0) 367.0 -}}
{{- $hours := mulf (divf $rowsPerChunk $rows) 24.0 | floor | int -}}
{{- $hours = max 1 (min 168 $hours) -}}
{{- if eq (mod $hours 24) 0 -}}
{{- $days := div $hours 24 -}}
{{- printf "%d %s" $days (ternary "day" "days" (eq $days 1)) -}}
{{- else -}}
{{- printf "%d %s" $hours (ternary "hour" "hours" (eq $hours 1)) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
timescaledb.retention.compressAfter, or one chunk interval.
*/}}
{{- define "aber.timescaleCompressAfter" -}}
{{- .Values.timescaledb.retention.compressAfter | default (include "aber.timescaleChunkInterval" .) -}}
{{- end -}}

{{/*
The historian's physical backup (timescaledb.physicalBackup): pgBackRest's configuration, and the
environment, mounts and volumes both of the containers that run it share -- the server's, for
archive-push and archive-get, and the backup sidecar's.
*/}}
{{- define "aber.physicalBackupOn" -}}
{{- if and .Values.timescaledb.enabled .Values.timescaledb.physicalBackup.enabled }}true{{ end -}}
{{- end -}}

{{- define "aber.validatePhysicalBackup" -}}
{{- if include "aber.physicalBackupOn" . -}}
{{- $b := .Values.timescaledb.physicalBackup -}}
{{- if eq $b.repo.type "s3" -}}
{{- $s := $b.repo.s3 -}}
{{- $missing := list -}}
{{- range $k := list "endpoint" "region" "bucket" "existingSecret" -}}
{{- if not (get $s $k) }}{{ $missing = append $missing (printf "timescaledb.physicalBackup.repo.s3.%s" $k) }}{{ end -}}
{{- end -}}
{{- if $missing -}}
{{- fail (printf "\n\naber: timescaledb.physicalBackup.repo.type is s3, and these are empty:\n  %s\n\nThe Secret named by existingSecret holds AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and\nREPO_CIPHER_PASS. Or set repo.type: posix for a volume in this cluster.\n" (join "\n  " $missing)) -}}
{{- end -}}
{{- if not (hasPrefix "https://" $s.endpoint) -}}
{{- fail (printf "\n\naber: timescaledb.physicalBackup.repo.s3.endpoint is %q.\n\npgBackRest reaches S3 over https only. Give the full URL, e.g. https://s3.eu-west-2.amazonaws.com;\nfor an endpoint with a private CA, name a Secret holding its ca.crt in repo.s3.caSecret.\n" $s.endpoint) -}}
{{- end -}}
{{- else if ne $b.repo.type "posix" -}}
{{- fail (printf "\n\naber: timescaledb.physicalBackup.repo.type is %q; it is s3 or posix.\n" $b.repo.type) -}}
{{- end -}}
{{- $h := int $b.hourUtc -}}{{- $d := int $b.fullOn -}}
{{- if or (lt $h 0) (gt $h 23) (lt $d 0) (gt $d 6) -}}
{{- fail (printf "\n\naber: timescaledb.physicalBackup.hourUtc is %v and fullOn is %v; they are 0-23 and 0-6 (0 = Sunday).\n" $b.hourUtc $b.fullOn) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* pgbackrest.conf. Credentials are not in it: they arrive as PGBACKREST_* environment variables. */}}
{{- define "aber.pgbackrestConf" -}}
{{- $b := .Values.timescaledb.physicalBackup -}}
[global]
repo1-type={{ $b.repo.type }}
repo1-retention-full={{ int $b.retainFull }}
{{- if eq $b.repo.type "s3" }}
{{- $s := $b.repo.s3 }}
{{- $u := urlParse $s.endpoint }}
{{- $hostPort := splitList ":" $u.host }}
repo1-path={{ $s.path }}
repo1-s3-endpoint={{ first $hostPort }}
{{- if gt (len $hostPort) 1 }}
repo1-storage-port={{ last $hostPort }}
{{- end }}
repo1-s3-region={{ $s.region }}
repo1-s3-bucket={{ $s.bucket }}
repo1-s3-uri-style={{ ternary "path" "host" $s.pathStyle }}
repo1-storage-verify-tls={{ ternary "y" "n" $s.verifyTls }}
{{- if $s.caSecret }}
repo1-storage-ca-file=/etc/aber/pgbackrest-ca/ca.crt
{{- end }}
repo1-cipher-type=aes-256-cbc
{{- else }}
repo1-path=/var/lib/pgbackrest
{{- end }}
compress-type=zst
process-max={{ int $b.processMax }}
start-fast=y
archive-async=y
spool-path=/var/lib/postgresql/data/pgbackrest-spool
archive-push-queue-max={{ $b.archiveQueueMax }}
log-level-console=info
log-level-file=off
lock-path=/var/run/postgresql/pgbackrest-lock

[historian]
pg1-path=/var/lib/postgresql/data/pgdata
pg1-socket-path=/var/run/postgresql
pg1-user={{ .Values.timescaledb.username }}
pg1-database={{ .Values.timescaledb.database }}
{{- end -}}

{{/* The server flags that turn WAL archiving on. */}}
{{- define "aber.physicalBackupServerArgs" -}}
- -c
- archive_mode=on
- -c
- archive_command=pgbackrest --stanza=historian archive-push %p
- -c
- archive_timeout={{ int .Values.timescaledb.physicalBackup.archiveTimeoutSeconds }}
{{- end -}}

{{- define "aber.physicalBackupEnv" -}}
{{- $s := .Values.timescaledb.physicalBackup.repo.s3 -}}
{{- if eq .Values.timescaledb.physicalBackup.repo.type "s3" -}}
- name: PGBACKREST_REPO1_S3_KEY
  valueFrom: { secretKeyRef: { name: {{ $s.existingSecret }}, key: AWS_ACCESS_KEY_ID } }
- name: PGBACKREST_REPO1_S3_KEY_SECRET
  valueFrom: { secretKeyRef: { name: {{ $s.existingSecret }}, key: AWS_SECRET_ACCESS_KEY } }
- name: PGBACKREST_REPO1_CIPHER_PASS
  valueFrom: { secretKeyRef: { name: {{ $s.existingSecret }}, key: REPO_CIPHER_PASS } }
{{- end -}}
{{- end -}}

{{- define "aber.physicalBackupMounts" -}}
- name: pgbackrest-conf
  mountPath: /etc/pgbackrest
  readOnly: true
- name: pgsocket
  mountPath: /var/run/postgresql
{{- if eq .Values.timescaledb.physicalBackup.repo.type "posix" }}
- name: pgbackrest-repo
  mountPath: /var/lib/pgbackrest
{{- else if .Values.timescaledb.physicalBackup.repo.s3.caSecret }}
- name: pgbackrest-ca
  mountPath: /etc/aber/pgbackrest-ca
  readOnly: true
{{- end }}
{{- end -}}

{{- define "aber.physicalBackupVolumes" -}}
- name: pgbackrest-conf
  configMap:
    name: {{ printf "%s-timescaledb-pgbackrest" (include "aber.fullname" .) }}
    items:
      - key: pgbackrest.conf
        path: pgbackrest.conf
- name: pgbackrest-script
  configMap:
    name: {{ printf "%s-timescaledb-pgbackrest" (include "aber.fullname" .) }}
    defaultMode: 0555
    items:
      - key: historian-backup.sh
        path: historian-backup.sh
- name: pgsocket
  emptyDir: {}
{{- if eq .Values.timescaledb.physicalBackup.repo.type "posix" }}
- name: pgbackrest-repo
  persistentVolumeClaim:
    claimName: {{ printf "%s-historian-backup" (include "aber.fullname" .) }}
{{- else if .Values.timescaledb.physicalBackup.repo.s3.caSecret }}
- name: pgbackrest-ca
  secret:
    secretName: {{ .Values.timescaledb.physicalBackup.repo.s3.caSecret }}
    items:
      - key: ca.crt
        path: ca.crt
{{- end }}
{{- end -}}
