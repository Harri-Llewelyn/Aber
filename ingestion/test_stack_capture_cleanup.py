"""
The request the capture stack suites clean up with, checked without a stack.

    python ingestion/test_stack_capture_cleanup.py

`test_playback_replay.py` and `test_recorded_capture_replay.py` each leave one object in
`broker-captures`, and `Session.remove()` deletes it. Storage answers a DELETE that carries a JSON
content type and no body with 400. The cleanup ignored the status, so every run left its file
behind and nothing failed. These tests hold the request to the shape storage-js's `remove()` sends,
which the Capture page uses, and hold a refusal to an error.

Importing the stack suite runs none of its tests and does not need the stack: its module setup
belongs to its own run.
"""
import io
import json
import os
import sys
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_playback_replay as stack  # noqa: E402

PATH = "dev270000000000400080000/capture.json"


class FakeResponse:
    def __init__(self, status, raw):
        self.status, self.raw = status, raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self.raw


class SessionRemove(unittest.TestCase):
    def remove(self, answer):
        """Session.remove(PATH) against `answer`, a response or an HTTPError to raise."""
        sent = []

        def urlopen(request, timeout=None):
            sent.append(request)
            if isinstance(answer, Exception):
                raise answer
            return answer

        with patch.object(urllib.request, "urlopen", urlopen):
            result = stack.Session("token").remove(PATH)
        return result, sent

    def test_it_names_the_path_in_the_body_of_a_delete_on_the_bucket(self):
        deleted, sent = self.remove(FakeResponse(200, json.dumps([{"name": PATH}]).encode()))
        self.assertEqual(len(sent), 1)
        request = sent[0]
        self.assertEqual(request.get_method(), "DELETE")
        self.assertEqual(request.full_url,
                         "%s/storage/v1/object/%s" % (stack.SUPABASE_URL, stack.BUCKET))
        self.assertEqual(json.loads(request.data), {"prefixes": [PATH]})
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertEqual(request.get_header("Authorization"), "Bearer token")
        self.assertEqual(deleted, [{"name": PATH}])

    def test_a_refusal_raises_and_names_the_status(self):
        body = io.BytesIO(json.dumps({
            "statusCode": "400", "error": "FST_ERR_CTP_EMPTY_JSON_BODY",
            "message": "Body cannot be empty when content-type is set to 'application/json'",
        }).encode())
        refusal = urllib.error.HTTPError("http://storage", 400, "Bad Request", {}, body)
        with self.assertRaisesRegex(AssertionError, "could not delete .*: 400"):
            self.remove(refusal)
        self.assertTrue(body.closed, "the error response was left open")


if __name__ == "__main__":
    unittest.main()
