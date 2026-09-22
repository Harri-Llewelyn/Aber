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
FROM nodered/node-red:5.0.2

# passport itself, passport-strategy, passport-http-bearer and oauth2orize already ship with
# the image; only the OAuth2 strategy and the JWT verifier are missing.
#
# passport-oauth2, NOT passport-openidconnect. The latter always requests the `openid` scope and
# requires an id_token in the token response -- GoTrue refuses to mint one ("HS256 is not
# supported for ID token signing") because this whole stack is HS256 on a shared secret, and its
# discovery document reports issuer "" with relative paths, which fails issuer validation too.
# Identity comes from the nodered-userinfo edge function instead. Same arrangement as
# grafana.ini's [auth.generic_oauth], and the reasoning is spelled out there.
RUN npm install --no-audit --no-fund --no-update-notifier --save \
      passport-oauth2@1.8.0 \
      jsonwebtoken@9.0.2

# THE PROVISIONING SCRIPT, baked in rather than mounted from a ConfigMap. Node-RED is its only
# caller, and Helm stores the chart archive and the rendered manifest in one release Secret under a
# 1 MiB cap. The chart runs it as the initContainer's command; an edit to it therefore needs this
# image rebuilt, which the dev loop does on `up`.
COPY node-red-init.mjs /opt/aber/node-red-init.mjs
