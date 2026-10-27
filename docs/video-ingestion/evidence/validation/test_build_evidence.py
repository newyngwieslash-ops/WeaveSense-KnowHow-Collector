import unittest

from build_evidence import go_counts, node_counts, python_counts, sanitize


class EvidenceTests(unittest.TestCase):
    def test_redacts_credentials_and_preserves_only_explicit_canary(self):
        raw = b'PASSWORD=unknown\npassword="unseen value"\nAPI_KEY=abc123\npassword=synthetic\nCookie: session=opaque; csrf=opaque\nAuthorization: Bearer opaque123\nhttps://user:pass@example.invalid/a?sig=abcdef\neyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef\n-----BEGIN PRIVATE KEY-----\nsecretbody\n-----END PRIVATE KEY-----\n'
        cleaned, counts, retained = sanitize(raw)
        for value in (b'unknown', b'unseen value', b'abc123', b'opaque', b'user:pass', b'abcdef', b'secretbody', b'eyJ'):
            self.assertNotIn(value, cleaned)
        self.assertIn(b'password=synthetic', cleaned)
        self.assertEqual(retained, 1)
        self.assertGreater(counts['credential_assignment'], 0)
        self.assertEqual(counts['pem_private_key'], 1)
        self.assertEqual(counts['jwt'], 1)

    def test_all_rule_counts_are_explicit(self):
        _, counts, _ = sanitize(b'--- PASS: fixture (1.0s)\n')
        self.assertTrue(counts)
        self.assertTrue(all(count == 0 for count in counts.values()))

    def test_hashes_and_synthetic_ids_are_not_secret_patterns(self):
        raw = b'executable_sha256=ecb81c128001b0cd724fa8c296bfd8e59252563d1e71e7234e5080ef2dbea7e1 operation_id=op_1234\n'
        self.assertEqual(sanitize(raw)[0], raw)

    def test_only_go_top_level_results_are_counted(self):
        text = '--- PASS: Parent (1.0s)\n    --- PASS: Child (1.0s)\n        --- SKIP: ChildOnly (0.0s)\n--- SKIP: Top (0.0s)\nok \tpkg\t1.0s\n'
        result = go_counts(text)
        self.assertEqual((result['passed'], result['skipped'], result['failed'], result['packages_passed']), (1, 1, 0, 1))

    def test_node_missing_summary_stays_unknown(self):
        self.assertIsNone(node_counts('test in progress')['pass'])
        self.assertEqual(node_counts('\u2139 tests 2\n\u2139 pass 2\n\u2139 fail 0\n')['pass'], 2)

    def test_asr_skip_is_counted_and_explained(self):
        result = python_counts("test_one (Suite.test_one) ... ok\ntest_model (Suite.test_model) ... skipped 'not installed'\nRan 2 tests in 0.549s\nOK (skipped=1)\n")
        self.assertEqual((result['tests'], result['passed'], result['skipped']), (2, 1, 1))
        self.assertTrue(result['successful_terminal_summary'])
        self.assertEqual(result['skip_details'][0]['reason'], 'not installed')

    def test_env_and_signing_keys_are_redacted_without_object_paths(self):
        raw = b'CANVAS_MASTER_KEY=secretvalue\nsigning_key=signingvalue\nobject_key=tenants/tn_synthetic/file\n'
        clean, counts, _ = sanitize(raw)
        self.assertNotIn(b'secretvalue', clean)
        self.assertNotIn(b'signingvalue', clean)
        self.assertIn(b'object_key=tenants/tn_synthetic/file', clean)
        self.assertEqual(counts['credential_assignment'], 2)

    def test_sanitizer_is_idempotent(self):
        raw = b'Authorization: Bearer test-opaque\npassword="secret"\n/workspace/scratch/example/file\n'
        once = sanitize(raw)[0]
        twice, counts, _ = sanitize(once)
        self.assertEqual(once, twice)
        self.assertTrue(all(value == 0 for value in counts.values()))


if __name__ == '__main__':
    unittest.main()
