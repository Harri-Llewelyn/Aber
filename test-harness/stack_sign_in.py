"""
Sign in with a password from a stack-lane suite, waiting out a sign-in rate limit.

The stack lane reaches the gateway through a port-forward, so every suite's sign-in arrives from
loopback and they all draw on one budget: GoTrue's token endpoint allows a burst of 30 per address
and refills about one every two seconds, and the gateway's sign-in total of 120 a minute stands in
front of it (supabase/test_auth_rate_limit.py explains both). Whether a suite meets a 429 depends on
how quickly the suites before it signed in.

password_grant() waits a 429 out within a bound, then fails naming the status and the body. A 429
is never a skip: it says nothing about whether the seed personas exist. Every other answer goes
back to the suite, which keeps its own rule for a stack without them: GoTrue answers 400 for an
account that does not exist.

Every suite that uses this puts test-harness/ on sys.path first, as the stack_exec users do.
"""
import json
import time
import urllib.error
import urllib.request

# Seconds between attempts after a 429: 30 s in all, which refills GoTrue's per-address budget by
# about fifteen sign-ins.
WAITS_S = (2, 4, 8, 16)

# GoTrue's answer to a password grant for an email with no account, as for a wrong password.
NO_SUCH_ACCOUNT = 400


class RateLimited(AssertionError):
    """Still refused with 429 after the last wait."""


def _post(url, apikey, payload, timeout):
    req = urllib.request.Request(url, method="POST", data=json.dumps(payload).encode(),
                                 headers={"apikey": apikey, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            status, text = response.status, response.read().decode()
    except urllib.error.HTTPError as err:
        with err:
            status, text = err.code, err.read().decode()
    try:
        return status, json.loads(text) if text else None
    except ValueError:
        return status, text


def describe(email, status, body):
    """A refused sign-in in words: the status, "rate-limited" for a 429, and what the server said."""
    limited = ", rate-limited" if status == 429 else ""
    return f"could not sign in as {email} ({status}{limited}): {str(body)[:300]}"


def password_grant(supabase_url, apikey, email, password, *, waits=WAITS_S, sleep=time.sleep,
                   timeout=20, post=_post):
    """(status, parsed JSON or text) for one password grant; a 429 is retried, then raised."""
    url = f"{supabase_url}/auth/v1/token?grant_type=password"
    for attempt, wait in enumerate((*waits, None), start=1):
        status, body = post(url, apikey, {"email": email, "password": password}, timeout)
        if status != 429:
            return status, body
        if wait is None:
            raise RateLimited(f"{describe(email, status, body)}; {attempt} attempts over {sum(waits)} s")
        sleep(wait)
