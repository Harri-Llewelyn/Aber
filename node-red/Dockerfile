# Node-RED with the modules /data/settings.js needs to authenticate against Supabase Auth.
#
# WHY A CUSTOM IMAGE AT ALL. settings.js lives on the `nodered_data` volume, and Node resolves
# `require()` from the requiring FILE's location -- so a bare `require('passport-oauth2')` in
# /data/settings.js searches /data/node_modules and /node_modules, never the image's
# /usr/src/node-red/node_modules. The modules are therefore required by ABSOLUTE PATH, the same
# idiom node-red-init.mjs already uses to reach @node-red/runtime's credentials module.
#
# The initContainer and the runtime both run this image, and that is load-bearing
# rather than tidiness: node-red-init's settingsAreCorrect() *evaluates* settings.js to see what
# it declares. An init container without these modules throws on the require, concludes the
# settings are wrong, and rewrites settings.js -- overwriting settings.js.bak -- on every single
# boot, silently, because that throw is already handled as "unloadable, replace it".
#
# THE BASE IS PINNED, not :latest. settings.js depends on three contracts that are internal
# enough to move between releases:
#   - adminAuth.authenticate receives the full profile object (users.js init())
#   - adminAuth.tokens may be a function, read from the Authorization: Bearer header
#     (users.js init() + strategies.js authenticateUserToken())
#   - httpNodeAuth may be Express middleware rather than {user, pass} (red.js:426)
# node-red-init.mjs carries the same kind of pin for the credentials runtime.
FROM nodered/node-red:5.0.7

# WHAT THE BASE CARRIES THAT THIS IMAGE DOES NOT RUN, removed before anything is added (#347).
#
# The global npm at /usr/local/lib/node_modules/npm is the Node image's, and nothing resolves it:
# entrypoint.sh starts red.js with node directly, and PATH puts /usr/src/node-red/node_modules/.bin
# first, so the npm that runs -- the install below, the palette manager at run time -- is the copy
# Node-RED bundles. The global copy carried this image's only fixable npm findings.
#
# `apk upgrade` takes the base's Alpine packages to the distribution's current fixes, so a fix
# Alpine ships between two base cuts reaches the release rather than waiting for the next base.
USER root
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
USER node-red

# passport itself, passport-strategy, passport-http-bearer and oauth2orize already ship with
# the image; only the OAuth2 strategy and the JWT verifier are missing.
#
# passport-oauth2, NOT passport-openidconnect. The latter always requests the `openid` scope and
# requires an id_token in the token response -- GoTrue refuses to mint one ("HS256 is not
# supported for ID token signing") because this whole stack is HS256 on a shared secret, and its
# discovery document reports issuer "" with relative paths, which fails issuer validation too.
# Identity comes from the nodered-userinfo edge function instead. Same arrangement as
# grafana.ini's [auth.generic_oauth], and the reasoning is spelled out there.
#
# THE OVERRIDES lift two packages in Node-RED's own tree to the patches that fix their advisories,
# each keyed to the major it replaces: axios, and Express's proxy-addr (CVE-2026-90711, critical).
# Each goes when the pinned base ships that version; the release scan says.
RUN node -e ' \
      const f = "/usr/src/node-red/package.json"; \
      const p = JSON.parse(require("fs").readFileSync(f)); \
      p.overrides = { ...p.overrides, "axios@^1": "1.20.0", "proxy-addr@^2": "2.0.8" }; \
      require("fs").writeFileSync(f, JSON.stringify(p, null, 2) + "\n");' \
 && npm install --no-audit --no-fund --no-update-notifier --save \
      passport-oauth2@1.8.0 \
      jsonwebtoken@9.0.2

# NPM'S BUNDLED undici AND brace-expansion, replaced by their patch releases (same dependencies,
# same engines). Node-RED's palette manager runs this npm, and an override cannot reach a bundled
# tree; npm 11.21.0, the newest, still bundles undici 6.28.0 and brace-expansion 5.0.9. `npm pack`
# checks each tarball against the registry's integrity. Both lines go when npm bundles the fixes.
RUN cd /tmp && npm pack --silent undici@6.28.1 brace-expansion@5.0.11 \
 && for p in undici brace-expansion; do \
      d=/usr/src/node-red/node_modules/npm/node_modules/$p; \
      rm -rf "$d" && mkdir -p "$d" && tar -xzf /tmp/$p-*.tgz -C "$d" --strip-components=1; \
    done \
 && rm -f /tmp/*.tgz

# THE PROVISIONING SCRIPT, baked in rather than mounted from a ConfigMap. Node-RED is its only
# caller, and Helm stores the chart archive and the rendered manifest in one release Secret under a
# 1 MiB cap. The chart runs it as the initContainer's command; an edit to it therefore needs this
# image rebuilt, which the dev loop does on `up`.
COPY node-red-init.mjs /opt/aber/node-red-init.mjs
