"""
No service accepts a token signed with the shared secret, against a running stack.

Every token is signed ES256 by the key pair in SUPABASE_JWT_KEYS, and secrets.jwtSecret
(SUPABASE_JWT_SECRET) is read by GoTrue alone, which signs nothing with it. Realtime and Storage
each verify HS256 with a secret of their own (REALTIME_JWT_SECRET, STORAGE_JWT_SECRET).

This signs in as the seeded Administrator, then signs the session's own claims again HS256 three
times: with the shared secret, with Realtime's and with Storage's. Each is presented where the
session's ES256 token is served: PostgREST, GoTrue, a Realtime channel join over the socket,
Storage, the Node-RED admin API, and an edge function (nodered-userinfo). The ES256 token is
served everywhere, which is what makes each refusal mean something. The token signed with the
shared secret is refused everywhere, as is a service_role token signed with it. One signed with
Realtime's or Storage's secret is refused by every service but its own, which is not asked: what
each takes its own secret for (Realtime's /api routes, Storage's signed URLs) is its own affair.

The secrets come from the environment, as the stack lane (scripts/dev-cluster.mjs test) gives
every suite the release Secret's keys. Nothing is written.

    python supabase/test_no_service_accepts_the_shared_secret.py
"""
import base64
import hashlib
import hmac
import json
import os
import socket
import struct
import sys
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test-harness"))
import stack_sign_in  # noqa: E402  -- waits out the lane's shared sign-in limit

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321").rstrip("/")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
NODERED_BASE_URL = os.getenv("NODERED_BASE_URL", "http://localhost:1880").rstrip("/")
PASSWORD = os.getenv("ABER_SEED_PASSWORD", "aber123")
EMAIL = "admin@aber.local"
STRICT = os.getenv("REQUIRE_SEEDED_ACCOUNTS", "").lower() in ("1", "true", "yes")
SECRETS = {
    "shared": os.getenv("SUPABASE_JWT_SECRET", ""),
    "realtime": os.getenv("REALTIME_JWT_SECRET", ""),
    "storage": os.getenv("STORAGE_JWT_SECRET", ""),
}
# How long a channel join may take to be answered.
JOIN_TIMEOUT_S = 15


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def claims_of(token):
    part = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))


def sign_hs256(claims, secret):
    """`claims` signed HS256 with `secret`: no kid, as an HS256 token carries none."""
    head = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = b64url(json.dumps(claims, separators=(",", ":")).encode())
    signature = hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}.{b64url(signature)}"


def call(url, token, apikey=True):
    """The status of a GET with `token` as the bearer."""
    headers = {"Authorization": f"Bearer {token}"}
    if apikey:
        headers["apikey"] = PUBLISHABLE_KEY
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            response.read()
            return response.status
    except urllib.error.HTTPError as err:
        with err:
            return err.code


# -------------------------------------------------------------------------------------------------
# A Realtime channel join, over a WebSocket of the standard library's own making
# -------------------------------------------------------------------------------------------------
def _send_text(sock, text):
    """One masked text frame, as a client must send it (RFC 6455, 5.2)."""
    payload = text.encode()
    mask = os.urandom(4)
    head = bytes([0x81])
    if len(payload) < 126:
        head += bytes([0x80 | len(payload)])
    elif len(payload) < 1 << 16:
        head += bytes([0x80 | 126]) + struct.pack(">H", len(payload))
    else:
        head += bytes([0x80 | 127]) + struct.pack(">Q", len(payload))
    sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))


def _read_exact(sock, n, buffered):
    while len(buffered) < n:
        chunk = sock.recv(65536)
        if not chunk:
            raise ConnectionError("the socket closed")
        buffered += chunk
    return buffered[:n], buffered[n:]


def _read_frame(sock, buffered):
    """(opcode, payload bytes, what is left over) for the next frame the server sends, unmasked."""
    head, buffered = _read_exact(sock, 2, buffered)
    opcode, length = head[0] & 0x0F, head[1] & 0x7F
    if length == 126:
        ext, buffered = _read_exact(sock, 2, buffered)
        length = struct.unpack(">H", ext)[0]
    elif length == 127:
        ext, buffered = _read_exact(sock, 8, buffered)
        length = struct.unpack(">Q", ext)[0]
    payload, buffered = _read_exact(sock, length, buffered)
    return opcode, payload, buffered


def join_channel(access_token):
    """
    Whether Realtime lets `access_token` join a public channel: "ok", or why not ("error: ...",
    "closed"). The socket itself opens with the publishable key, which the gateway exchanges for
    the anon key, so only the join's token is under test.
    """
    url = urllib.parse.urlsplit(SUPABASE_URL)
    query = urllib.parse.urlencode({"apikey": PUBLISHABLE_KEY, "vsn": "1.0.0"})
    sock = socket.create_connection((url.hostname, url.port or 80), timeout=JOIN_TIMEOUT_S)
    try:
        key = base64.b64encode(os.urandom(16)).decode()
        sock.sendall((
            f"GET /realtime/v1/websocket?{query} HTTP/1.1\r\nHost: {url.netloc}\r\n"
            f"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n").encode())
        buffered = b""
        while b"\r\n\r\n" not in buffered:
            chunk = sock.recv(4096)
            if not chunk:
                raise AssertionError("Realtime closed the connection before the WebSocket handshake")
            buffered += chunk
        head, buffered = buffered.split(b"\r\n\r\n", 1)
        status_line = head.split(b"\r\n", 1)[0].decode(errors="replace")
        if " 101 " not in f"{status_line} ":
            raise AssertionError(f"the WebSocket handshake was answered {status_line!r}")

        topic = f"realtime:shared-secret-probe-{uuid.uuid4().hex[:8]}"
        _send_text(sock, json.dumps({
            "topic": topic, "event": "phx_join", "ref": "1", "join_ref": "1",
            "payload": {
                "config": {"broadcast": {"self": False}, "presence": {"key": ""}, "postgres_changes": [], "private": False},
                "access_token": access_token,
            },
        }))
        deadline = time.monotonic() + JOIN_TIMEOUT_S
        while time.monotonic() < deadline:
            try:
                opcode, payload, buffered = _read_frame(sock, buffered)
            except (ConnectionError, socket.timeout):
                return "closed"
            if opcode == 0x8:
                return "closed"
            if opcode != 0x1:
                continue
            message = json.loads(payload)
            if message.get("topic") != topic:
                continue
            if message.get("event") == "phx_reply" and message.get("ref") == "1":
                reply = message.get("payload") or {}
                if reply.get("status") == "ok":
                    return "ok"
                return f"error: {json.dumps(reply.get('response'))[:200]}"
            if message.get("event") in ("phx_error", "phx_close"):
                return message["event"]
            if message.get("event") == "system" and (message.get("payload") or {}).get("status") == "error":
                return f"error: {json.dumps(message['payload'])[:200]}"
        raise AssertionError(f"Realtime did not answer the join within {JOIN_TIMEOUT_S}s")
    finally:
        sock.close()


# -------------------------------------------------------------------------------------------------
# The services, each asked whether it serves a token
# -------------------------------------------------------------------------------------------------
SERVICES = {
    "PostgREST": lambda token: call(f"{SUPABASE_URL}/rest/v1/areas?select=id&limit=1", token) == 200,
    "GoTrue": lambda token: call(f"{SUPABASE_URL}/auth/v1/user", token) == 200,
    "Realtime": lambda token: join_channel(token) == "ok",
    "Storage": lambda token: call(f"{SUPABASE_URL}/storage/v1/bucket", token) == 200,
    "Node-RED": lambda token: call(f"{NODERED_BASE_URL}/flows", token, apikey=False) == 200,
    "an edge function": lambda token: call(f"{SUPABASE_URL}/functions/v1/nodered-userinfo", token) == 200,
}
# The service whose own secret each is, and so is not asked: none for the shared secret.
OWNER = {"shared": None, "realtime": "Realtime", "storage": "Storage"}


class NoServiceAcceptsTheSharedSecret(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        missing = [f"{name} ({var})" for name, var in
                   (("shared", "SUPABASE_JWT_SECRET"), ("realtime", "REALTIME_JWT_SECRET"), ("storage", "STORAGE_JWT_SECRET"))
                   if not SECRETS[name]]
        if missing or not PUBLISHABLE_KEY:
            reason = f"the release Secret's keys are not in the environment: {', '.join(missing) or 'SUPABASE_PUBLISHABLE_KEY'}"
            if STRICT:
                raise AssertionError(reason)
            raise unittest.SkipTest(reason)
        status, body = stack_sign_in.password_grant(SUPABASE_URL, PUBLISHABLE_KEY, EMAIL, PASSWORD)
        if status == stack_sign_in.NO_SUCH_ACCOUNT:
            reason = f"could not sign in as {EMAIL} ({status}); the seed personas are absent"
            if STRICT:
                raise AssertionError(f"{reason}, and REQUIRE_SEEDED_ACCOUNTS is set")
            raise unittest.SkipTest(reason)
        if status != 200:
            raise AssertionError(stack_sign_in.describe(EMAIL, status, body))
        cls.session = body["access_token"]
        header = json.loads(base64.urlsafe_b64decode(cls.session.split(".")[0] + "=="))
        cls.session_alg = header.get("alg")
        cls.claims = claims_of(cls.session)

    def test_the_session_is_es256_and_every_service_serves_it(self):
        self.assertEqual(self.session_alg, "ES256", "GoTrue signs the session ES256")
        refused = [name for name, serves in SERVICES.items() if not serves(self.session)]
        self.assertEqual(refused, [], "the session's own token is served everywhere, or the refusals below prove nothing")

    def test_the_session_signed_with_each_secret_is_refused_by_every_other_service(self):
        for which, secret in SECRETS.items():
            token = sign_hs256(self.claims, secret)
            for name, serves in SERVICES.items():
                if name == OWNER[which]:
                    continue
                with self.subTest(secret=which, service=name):
                    self.assertFalse(serves(token), f"{name} served the session's claims signed HS256 with the {which} secret")

    def test_a_service_role_token_signed_with_the_shared_secret_is_refused(self):
        now = int(time.time())
        forged = sign_hs256({"iss": "supabase", "role": "service_role", "iat": now, "exp": now + 300}, SECRETS["shared"])
        for name in ("PostgREST", "Storage"):
            with self.subTest(service=name):
                self.assertFalse(SERVICES[name](forged), f"{name} served service_role signed with the shared secret")


if __name__ == "__main__":
    unittest.main()
