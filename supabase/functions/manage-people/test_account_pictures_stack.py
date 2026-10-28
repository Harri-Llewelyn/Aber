"""
A person's picture through the real Storage API, and Remove Access deleting it (0213).

    python supabase/functions/manage-people/test_account_pictures_stack.py

Needs the stack up and its seeded people (scripts/dev-cluster.mjs test sets the environment). The
db lane runs the avatars policies on a stand-in table
(supabase/migrations/test_a_person_can_put_a_picture_on_their_account.py); what only storage-api
decides is held here:

  * a throwaway person uploads, replaces, downloads and deletes their own <id>/avatar;
  * the seeded Administrator, Shopfloor Manager, Operator and Auditor read, list, sign, overwrite
    and delete none of it, the public URL serves nothing, and a machine identity reaches nothing on
    the real storage.objects;
  * the bucket refuses SVG, GIF and HTML, and holds the 512 KiB limit storage-init set;
  * Remove Access deletes the object and clears avatar_path, and Restore Access brings the person
    back with no picture.

Each class adds its own person through manage-people and deletes the account afterwards.
REQUIRE_SEEDED_ACCOUNTS=1 makes a skip a failure.
"""
import base64
import json
import os
import unittest
import urllib.error
import urllib.request
import uuid

import psycopg2

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
SEEDED = {
    "Administrator": os.getenv("ABER_ADMIN_EMAIL", "admin@aber.local"),
    "Shopfloor_Manager": os.getenv("ABER_MANAGER_EMAIL", "manager@aber.local"),
    "Operator": os.getenv("ABER_OPERATOR_EMAIL", "operator@aber.local"),
    "Auditor": os.getenv("ABER_AUDITOR_EMAIL", "auditor@aber.local"),
}
SEEDED_PASSWORD = os.getenv("ABER_ADMIN_PASSWORD", "aber123")
REQUIRE = os.getenv("REQUIRE_SEEDED_ACCOUNTS") == "1"

DB = dict(
    host=os.getenv("SUPABASE_DB_HOST", "localhost"),
    port=os.getenv("SUPABASE_DB_PORT", "54322"),
    dbname=os.getenv("SUPABASE_DB_NAME", "postgres"),
    user=os.getenv("SUPABASE_DB_USER", "postgres"),
    password=os.getenv("SUPABASE_DB_PASSWORD", os.getenv("POSTGRES_PASSWORD", "postgres")),
    connect_timeout=10,
)

BUCKET = "avatars"
INGESTION = "b0000000-0000-4000-8000-000000000002"
PLAYBACK = "b0000000-0000-4000-8000-000000000003"

# A 1x1 PNG, and other bytes to replace it with: storage-api reads the declared type, not the bytes.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
PNG_TWO = PNG + b"\x00"


def skip_or_fail(message):
    if REQUIRE:
        raise AssertionError(f"REQUIRE_SEEDED_ACCOUNTS=1, so this cannot be skipped: {message}")
    raise unittest.SkipTest(message)


def call(url, method="GET", body=None, token=None, headers=None, raw=False):
    """One request through the gateway. Returns (status, parsed body or bytes)."""
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    sent = {"apikey": PUBLISHABLE_KEY, **({"Authorization": f"Bearer {token}"} if token else {}),
            **({"Content-Type": "application/json"} if data is not None and not isinstance(body, bytes) else {}),
            **(headers or {})}
    req = urllib.request.Request(url, method=method, data=data, headers=sent)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            payload = response.read()
            status = response.status
    except urllib.error.HTTPError as err:
        with err:
            payload = err.read()
            status = err.code
    except urllib.error.URLError as err:
        return 0, str(err.reason)
    if raw and 200 <= status < 300:
        return status, payload
    try:
        return status, json.loads(payload.decode() or "null")
    except (UnicodeDecodeError, json.JSONDecodeError):
        return status, payload


def sign_in(email, password):
    status, data = call(f"{SUPABASE_URL}/auth/v1/token?grant_type=password", "POST",
                        {"email": email, "password": password})
    if status != 200 or not isinstance(data, dict) or not data.get("access_token"):
        skip_or_fail(f"could not sign in as {email} ({status})")
    return data["access_token"]


def object_url(path, kind=""):
    return f"{SUPABASE_URL}/storage/v1/object/{kind}{BUCKET}/{path}"


def upload(token, path, payload, content_type, upsert=True):
    return call(object_url(path), "POST", payload, token,
                {"Content-Type": content_type, "x-upsert": "true" if upsert else "false"})


def download(token, path):
    return call(object_url(path, "authenticated/"), "GET", token=token, raw=True)


def delete(token, path):
    return call(f"{SUPABASE_URL}/storage/v1/object/{BUCKET}", "DELETE", {"prefixes": [path]}, token)


def rpc(token, fn, args):
    return call(f"{SUPABASE_URL}/rest/v1/rpc/{fn}", "POST", args, token)


def manage_people(token, body):
    return call(f"{SUPABASE_URL}/functions/v1/manage-people", "POST", body, token)


def owner_db():
    try:
        return psycopg2.connect(**DB)
    except psycopg2.Error as err:
        skip_or_fail(f"cannot reach the Supabase database as its owner: {err}")


def stored(path):
    """Whether storage.objects holds the picture, read as the database owner."""
    conn = owner_db()
    try:
        cur = conn.cursor()
        cur.execute("SELECT count(*) FROM storage.objects WHERE bucket_id = %s AND name = %s;", (BUCKET, path))
        return cur.fetchone()[0] == 1
    finally:
        conn.rollback()
        conn.close()


def bucket_limits():
    """The avatars bucket's file_size_limit and its sorted allowed_mime_types, as storage-init set them."""
    conn = owner_db()
    try:
        cur = conn.cursor()
        cur.execute("SELECT file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = %s;", (BUCKET,))
        row = cur.fetchone()
        return (row[0], sorted(row[1] or [])) if row else None
    finally:
        conn.rollback()
        conn.close()


def recorded(user_id):
    conn = owner_db()
    try:
        cur = conn.cursor()
        cur.execute("SELECT avatar_path FROM public.person_profiles WHERE user_id = %s;", (user_id,))
        row = cur.fetchone()
        return row[0] if row else None
    finally:
        conn.rollback()
        conn.close()


class Throwaway(unittest.TestCase):
    """A person added for the class through manage-people, signed in, and deleted afterwards."""

    @classmethod
    def setUpClass(cls):
        if not PUBLISHABLE_KEY:
            skip_or_fail("SUPABASE_PUBLISHABLE_KEY is not set; run through scripts/dev-cluster.mjs test")
        cls.tokens = {role: sign_in(email, SEEDED_PASSWORD) for role, email in SEEDED.items()}
        email = f"picture-{uuid.uuid4().hex[:10]}@aber.local"
        status, added = manage_people(cls.tokens["Administrator"], {"action": "add", "email": email, "role": "Operator"})
        if status != 200:
            raise AssertionError(f"manage-people would not add a throwaway person ({status}): {added}")
        cls.user_id = added["user_id"]
        cls.path = f"{cls.user_id}/avatar"
        cls.addClassCleanup(cls._delete_account)
        password = added.get("password")
        if not password:
            status, reset = manage_people(cls.tokens["Administrator"], {"action": "set-password", "user_id": cls.user_id})
            password = reset.get("password") if status == 200 else None
        if not password:
            raise AssertionError("the throwaway person has no password to sign in with")
        cls.token = sign_in(email, password)

    @classmethod
    def _delete_account(cls):
        if SERVICE_ROLE_KEY:
            delete(SERVICE_ROLE_KEY, cls.path)
        conn = owner_db()
        try:
            cur = conn.cursor()
            if not SERVICE_ROLE_KEY:
                cur.execute("SET LOCAL storage.allow_delete_query = 'true';")
                cur.execute("DELETE FROM storage.objects WHERE bucket_id = %s AND name = %s;", (BUCKET, cls.path))
            cur.execute("DELETE FROM public.user_roles WHERE user_id = %s;", (cls.user_id,))
            cur.execute("DELETE FROM auth.users WHERE id = %s;", (cls.user_id,))
            conn.commit()
        finally:
            conn.close()


class TheOwnerAloneReachesTheirPicture(Throwaway):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        status, body = upload(cls.token, cls.path, PNG, "image/png")
        if status != 200:
            raise AssertionError(f"the owner could not upload their picture ({status}): {body}")
        status, body = rpc(cls.token, "set_own_picture", {"p_present": True})
        if status != 200 or body != cls.path:
            raise AssertionError(f"set_own_picture() did not record it ({status}): {body}")

    def test_the_owner_downloads_replaces_and_reads_the_new_one(self):
        self.assertEqual(download(self.token, self.path), (200, PNG))
        status, _ = upload(self.token, self.path, PNG_TWO, "image/png")
        self.assertEqual(status, 200, "replacing the picture (upsert) was refused")
        self.assertEqual(download(self.token, self.path), (200, PNG_TWO))
        status, _ = upload(self.token, self.path, PNG, "image/png")
        self.assertEqual(status, 200)

    def test_nobody_else_reads_lists_or_signs_it(self):
        for role, token in self.tokens.items():
            with self.subTest(role=role):
                status, _ = download(token, self.path)
                self.assertNotEqual(status, 200, f"{role} downloaded another person's picture")
                status, listed = call(f"{SUPABASE_URL}/storage/v1/object/list/{BUCKET}", "POST",
                                      {"prefix": self.user_id, "limit": 10}, token)
                self.assertFalse(status == 200 and listed, f"{role} listed another person's picture: {listed}")
                status, signed = call(object_url(self.path, "sign/"), "POST", {"expiresIn": 60}, token)
                self.assertFalse(status == 200 and isinstance(signed, dict) and signed.get("signedURL"),
                                 f"{role} signed a link to another person's picture")
        status, _ = call(object_url(self.path, "public/"))
        self.assertNotEqual(status, 200, "the bucket serves pictures at a public URL")

    def test_nobody_else_overwrites_or_deletes_it(self):
        for role, token in self.tokens.items():
            with self.subTest(role=role):
                status, _ = upload(token, self.path, PNG_TWO, "image/png")
                self.assertNotEqual(status, 200, f"{role} overwrote another person's picture")
                delete(token, self.path)
                self.assertTrue(stored(self.path), f"{role} deleted another person's picture")
        self.assertEqual(download(self.token, self.path), (200, PNG))

    def test_a_machine_identity_reaches_nothing_on_the_real_table(self):
        conn = owner_db()
        try:
            cur = conn.cursor()
            cur.execute("SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' "
                        "AND policyname LIKE 'avatars\\_%';")
            self.assertEqual(cur.fetchone()[0], 4, "the storage-policies Job did not apply the four avatars policies")
            for sub in (INGESTION, PLAYBACK):
                with self.subTest(sub=sub):
                    cur.execute("SAVEPOINT m;")
                    cur.execute("SET LOCAL ROLE authenticated;")
                    cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                                ('{"sub": "%s", "role": "authenticated"}' % sub,))
                    cur.execute("SELECT count(*) FROM storage.objects WHERE bucket_id = %s;", (BUCKET,))
                    self.assertEqual(cur.fetchone()[0], 0)
                    cur.execute("ROLLBACK TO SAVEPOINT m;")
        finally:
            conn.rollback()
            conn.close()

    def test_the_bucket_refuses_another_type_and_a_large_file(self):
        other = f"{self.user_id}/avatar"
        for content_type in ("image/svg+xml", "image/gif", "text/html", "application/octet-stream"):
            with self.subTest(content_type=content_type):
                status, body = upload(self.token, other, b"<svg xmlns='http://www.w3.org/2000/svg'/>", content_type)
                self.assertNotEqual(status, 200, f"the bucket took {content_type}: {body}")
        # The size limit is read from the bucket, not sent: storage answers a body over it before
        # reading it and resets the connection, and kubectl port-forward then exits, taking the
        # stack lane's shared gateway forward with it.
        self.assertEqual(bucket_limits(), (512 * 1024, ["image/jpeg", "image/png", "image/webp"]))
        self.assertEqual(download(self.token, self.path), (200, PNG), "a refused upload changed the picture")

    def test_zz_the_owner_deletes_it_and_records_none(self):
        status, _ = delete(self.token, self.path)
        self.assertEqual(status, 200)
        self.assertFalse(stored(self.path))
        self.assertEqual(rpc(self.token, "set_own_picture", {"p_present": False}), (200, None))
        self.assertIsNone(recorded(self.user_id))


class RemoveAccessDeletesThePicture(Throwaway):

    def test_remove_access_deletes_the_object_and_restore_brings_no_picture_back(self):
        status, body = upload(self.token, self.path, PNG, "image/png")
        self.assertEqual(status, 200, body)
        rpc(self.token, "set_own_picture", {"p_present": True})
        self.assertTrue(stored(self.path))
        self.assertEqual(recorded(self.user_id), self.path)

        admin = self.tokens["Administrator"]
        status, body = manage_people(admin, {"action": "remove", "user_id": self.user_id})
        self.assertEqual(status, 200, body)
        self.assertFalse(stored(self.path), "Remove Access left the picture in the bucket")
        self.assertIsNone(recorded(self.user_id), "Remove Access left avatar_path set")

        status, body = manage_people(admin, {"action": "remove", "user_id": self.user_id})
        self.assertEqual(status, 200, f"a second Remove Access did not finish cleanly: {body}")

        status, body = manage_people(admin, {"action": "restore", "user_id": self.user_id})
        self.assertEqual(status, 200, body)
        self.assertIsNone(recorded(self.user_id))
        self.assertFalse(stored(self.path))


if __name__ == "__main__":
    unittest.main(verbosity=2)
