# Sign in with Aber: a guide for an app's author

**In short:** how to let people sign in to an app you built with their Aber account, so they
need no second login. This reference page is for the person who builds the app. It covers
registration, the sign-in flow, checking the ID token, token lifetimes, and what the app's token can
and cannot reach.

An Administrator registers the app. The app then learns who the person is, and nothing more. It
cannot read Aber's data or change anything in Aber.

## What your app gets

- **Who the person is.** An OpenID Connect ID token when you ask for the `openid` scope. The
  user-info endpoint, with their email address and name when you ask for `email` and `profile`.
- **Nothing else.** The access token Aber gives your app is refused by every part of Aber that holds
  data. That covers the API, file storage and every Aber function. It reaches only the sign-in
  endpoints in [What the app's token can reach](#what-the-apps-token-can-reach).
- **A session that is always `aal1`.** See [A second factor ends the app's session](#a-second-factor-ends-the-apps-session).

If your app also needs to read Aber's data, that is a separate grant that Aber does not offer yet.
Ask the Administrator for a read-only API client's token for that, and sign people in with Aber for
who they are.

## 1. Ask an Administrator to register the app

An Administrator opens **Access Control**, then **Apps**, and selects **Register App**.

1. **Name.** What a person sees when the app asks to sign them in. It must differ from every app
   already registered.
2. **Type.** Choose **Confidential** for an app that runs on a server and can keep a secret. Choose
   **Public** for a browser or desktop app, which cannot. A public app uses PKCE alone.
3. **Addresses it sends people back to.** One to ten, one to a line. Your app must ask for one of them
   exactly, character for character.
4. Select **Register App**. The dialog shows the **client ID** and the **discovery address**. For a
   confidential app it also shows the **client secret**.

**Copy the secret before you close the dialog.** Aber keeps only a hash of it, so it is shown once.
If it is lost, the Administrator removes the app and registers it again.

### Which addresses are allowed

- **`https` goes anywhere.**
- **Plain `http` goes only on the site's own network:** `localhost` and any name ending `.localhost`,
  loopback and private addresses (`127.x.x.x`, `10.x.x.x`, `172.16.x.x` to `172.31.x.x`,
  `192.168.x.x`), `[::1]`, and the site's own domain and every name under it.
- **Nothing else is accepted.** No wildcard, fragment (`#`), comma, space, user name or password, and
  no scheme but `http` and `https`.

The dialog names the address that breaks a rule and says which one.

## 2. Find the endpoints

Fetch the discovery document. Its address is the issuer, then `/.well-known/openid-configuration`:

```
GET https://api.<site>/auth/v1/.well-known/openid-configuration
```

It names the `issuer`, the `authorization_endpoint`, the `token_endpoint`, the `userinfo_endpoint`
and the `jwks_uri`. A sign-in library given the discovery address needs nothing else. The
issuer is the site's public auth address, `https://api.<site>/auth/v1`. Every token Aber signs
carries it as `iss`.

## 3. Send the person to Aber

Make a PKCE pair first. The **code verifier** is a random string of 43 to 128 characters. The **code
challenge** is the verifier's SHA-256 hash, base64url encoded with no padding. Aber requires PKCE of
every app, public or confidential.

Send the person's browser to the `authorization_endpoint` with these parameters:

| Parameter | Value |
| :--- | :--- |
| `response_type` | `code` |
| `client_id` | The client ID from the dialog |
| `redirect_uri` | One of the registered addresses, exactly |
| `scope` | `openid`, and `email` and `profile` if you need them |
| `state` | A random value you check on the way back |
| `nonce` | A random value you check in the ID token |
| `code_challenge` | The challenge |
| `code_challenge_method` | `S256` |

Aber asks the person to sign in. The first time, it also shows your app's name and the scopes you
asked for, and the person allows it. They answer once, and Aber remembers.

While Settings requires a second factor, an Administrator or Shopfloor Manager gives a code before
they can allow an app. Other roles are not asked.

Aber then sends the browser back to your `redirect_uri` with `code` and `state`. **Check `state`
first.**

## 4. Exchange the code

The code is single-use. Exchange it at once at the `token_endpoint`:

```
POST https://api.<site>/auth/v1/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=<code>&redirect_uri=<the same address>&code_verifier=<verifier>
```

- **A confidential app** sends its client ID and secret as HTTP Basic credentials: `Authorization:
  Basic` and the base64 of `<client ID>:<client secret>`. Aber accepts only the method the app is
  registered for, so a secret sent in the body is refused.
- **A public app** sends `client_id=<client ID>` in the body and no secret.

The answer is JSON with `access_token`, `token_type`, `expires_in`, `refresh_token` and, when you
asked for `openid`, `id_token`.

## 5. Check the ID token

Do not trust an ID token you have not checked.

1. Fetch the key set at the `jwks_uri` and cache it. Aber signs with ES256.
2. Find the key whose `kid` the token's header names. Check the signature.
3. Check that `iss` is the issuer from the discovery document.
4. Check that `aud` is your client ID.
5. Check that `exp` has not passed, and that `nonce` is the one you sent.

The ID token's `sub` is the person's account ID. It does not change, so key your own records on it.
It does not carry the person's role in Aber.

## 6. Ask who the person is

Send the access token to the `userinfo_endpoint`:

```
GET https://api.<site>/auth/v1/oauth/userinfo
Authorization: Bearer <access token>
```

The answer always holds `sub`. It holds `email` and `email_verified` for the `email` scope, and `name`,
`picture` and `preferred_username` where they are set for the `profile` scope.

## 7. Keep the session going

Refresh at the `token_endpoint`:

```
POST https://api.<site>/auth/v1/oauth/token

grant_type=refresh_token&refresh_token=<refresh token>
```

Authenticate as in step 4: Basic credentials for a confidential app, `client_id` in the body for a
public one. **Each refresh returns a new refresh token. Keep it and drop the old one.** A refresh does
not return a new ID token.

To end the session, send the access token to Aber's sign-out. Only the local scope is accepted:

```
POST https://api.<site>/auth/v1/logout?scope=local
Authorization: Bearer <access token>
```

## Token lifetimes

| Token | Lifetime |
| :--- | :--- |
| Access token | One hour by default. The site sets it (`supabaseAuth.jwtExpiry`). `expires_in` says. |
| ID token | One hour. It is not refreshed: sign the person in again for a new one. |
| Refresh token | Until the session ends. The session ends after the site's inactivity timeout with no refresh (seven days by default), or sooner for the reasons below. |
| Authorization code | Single-use, and good only for a short time. |

The session ends sooner when the person takes back their approval on their **Profile** page, when an
Administrator revokes it or removes the app, when the person's access is removed, and when they
change their password. Your next refresh is then refused. Send the person through sign-in again.

## A second factor ends the app's session

**An app's session is always `aal1`.** That is the assurance level of a sign-in without a second
factor, and Aber never raises an app's session above it. Do not ask for more.

**The session ends whenever the person enters a second-factor code, in any browser.** Aber ends every
other `aal1` session the person holds when one of their sessions rises to `aal2`. Your refresh is
then refused. Treat that as a sign-out: send the person through sign-in again. It happens to every
person who has enrolled a second factor.

## What the app's token can reach

| Endpoint | What it is for |
| :--- | :--- |
| `POST /auth/v1/oauth/token` | The code exchange and the refresh, the endpoint discovery names |
| `POST /auth/v1/token` | The sign-in service's own token endpoint, for a library written for it. Use the one above unless yours needs this |
| `GET /auth/v1/oauth/userinfo` | Who the person is, by the scopes they allowed |
| `GET /auth/v1/user` | The sign-in service's own read of the person's account, for the same token |
| `POST /auth/v1/logout?scope=local` | Ends the app's session, and only that one |
| `GET /auth/v1/.well-known/openid-configuration` | Discovery |
| `GET /auth/v1/.well-known/oauth-authorization-server` | The same document, for a library that asks for it by its other name |
| `GET /auth/v1/.well-known/jwks.json` | The key set that verifies a token |

**Everything else is refused with a 403 from the gateway.** That covers the rest of `/auth/v1/`: the
person's password and email, their second factors, their other approvals and the consent calls. It
covers the data API, file storage and every Aber function too.

The gateway decides this on the token's `client_id`, so a token an app holds cannot be exchanged for
more. The rules are in the [security model](security-model.md#an-apps-token-reaches-only-its-own-routes).

## If something fails

- **`invalid redirect_uri` at the authorize step.** The address your app sent is not one registered,
  character for character. A trailing slash counts.
- **`invalid credentials` at the token endpoint.** A confidential app sent its secret the wrong way.
  Use HTTP Basic. A public app must send no secret.
- **A 403 from the gateway.** The app's token was sent somewhere it cannot reach.
- **A refusal on refresh.** The session has ended. Send the person through sign-in again.
- **A browser app's call to the token endpoint is blocked by the browser.** The site allows only
  the origins it lists. The person who installs Aber adds your app's origin to
  `global.corsExtraOrigins` in the chart's values. A server-side app is not affected.
