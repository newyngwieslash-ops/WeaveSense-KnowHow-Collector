"""Real loopback HTTP failure boundaries, not external platform availability."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest

from core import Failure, InternalClient


@contextmanager
def server(callback):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            callback(self)
        def log_message(self, *_args):
            pass
    instance = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=instance.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{instance.server_address[1]}"
    finally:
        instance.shutdown()
        instance.server_close()
        thread.join()


class TransportBoundaries(unittest.TestCase):
    def test_fixed_provider_redirect_never_forwards_actual_credential(self):
        escaped, authenticated = [], []
        status = 301
        def target(request):
            escaped.append(dict(request.headers))
            request.send_response(200)
            request.end_headers()
        with server(target) as destination:
            def redirect(request):
                authenticated.append(request.headers.get("X-API-Key"))
                request.send_response(status)
                request.send_header("Location", destination + "/steal")
                request.end_headers()
            with server(redirect) as origin:
                client = InternalClient(origin, "synthetic-api-key-not-production", auth_header="X-API-Key")
                for status in (301, 302, 303, 307, 308):
                    with self.subTest(status=status), self.assertRaises(Failure) as caught:
                        client.open("GET", "/resource")
                    self.assertEqual(caught.exception.code, "REDIRECT_DENIED")
        self.assertEqual(authenticated, ["synthetic-api-key-not-production"] * 5)
        self.assertEqual(escaped, [])

    def test_provider_auth_and_rate_limit_keep_safe_reason_and_retry_after(self):
        status = 401
        def reject(request):
            request.send_response(status)
            request.send_header("Retry-After", "7")
            request.end_headers()
            request.wfile.write(b"synthetic private upstream detail")
        with server(reject) as origin:
            client = InternalClient(origin, "synthetic-api-key-not-production")
            for status, reason in ((401, "AUTH_REQUIRED"), (429, "RATE_LIMITED")):
                with self.subTest(status=status), self.assertRaises(Failure) as caught:
                    client.open("GET", "/resource")
                self.assertEqual(caught.exception.code, reason)
                self.assertEqual(caught.exception.status, status)
                self.assertEqual(caught.exception.retry_after, 7)
                self.assertNotIn("private", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
