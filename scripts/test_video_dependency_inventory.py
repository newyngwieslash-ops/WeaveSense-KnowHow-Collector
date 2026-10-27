"""Focused tests for the offline evidence collector, not application tests."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

PATH = Path(__file__).with_name("video-dependency-inventory.py")
SPEC = importlib.util.spec_from_file_location("inventory", PATH)
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)


class InventoryTests(unittest.TestCase):
    def test_source_baseline_never_uses_mutable_head(self):
        with mock.patch.object(inventory.subprocess, "check_output",
                               side_effect=[inventory.PINNED_UPSTREAM_COMMIT + "\n", b""]) as git:
            result = inventory.source_inventory()
        self.assertEqual(result["baseline_commit"], inventory.PINNED_UPSTREAM_COMMIT)
        self.assertEqual(git.call_args_list[0].args[0],
                         ["git", "rev-parse", "--verify", inventory.PINNED_UPSTREAM_COMMIT + "^{commit}"])
        self.assertEqual(git.call_args_list[1].args[0],
                         ["git", "ls-tree", "-r", "-l", "-z", inventory.PINNED_UPSTREAM_COMMIT])

    def test_source_baseline_rejects_unexpected_resolved_commit(self):
        with mock.patch.object(inventory.subprocess, "check_output", return_value="f" * 40 + "\n"):
            with self.assertRaisesRegex(RuntimeError, "different object"):
                inventory.source_inventory()

    def test_notice_names_exclude_ui_code_and_screenshots(self):
        for name in ["LICENSE", "LICENSE.txt", "NOTICE", "THIRD-PARTY-LICENSES.md"]:
            self.assertTrue(inventory.is_license_notice_name(name))
        for name in ["banner-notice.ts", "tldraw-license-key-settings.png", "route-fallback-notice.md"]:
            self.assertFalse(inventory.is_license_notice_name(name))

    def test_jsonc_preserves_url_and_quoted_comma(self):
        self.assertEqual(inventory.jsonc('{"url":"https://example.com/a//b", "text":",}", "list":[1,],}'),
                         {"url": "https://example.com/a//b", "text": ",}", "list": [1]})

    def test_jsonc_comments_and_escape(self):
        self.assertEqual(inventory.jsonc('/* first */ {"text": "\\\"//", // line\n "n": 1,}'),
                         {"text": '"//', "n": 1})

    def test_invalid_json_is_not_executed(self):
        with self.assertRaises(json.JSONDecodeError):
            inventory.jsonc('{"x": process.exit(0)}')
        with self.assertRaises(ValueError):
            inventory.jsonc('/* missing end')

    def test_url_credentials_query_fragment_removed(self):
        self.assertEqual(inventory.safe_url("https://user:secret@example.com/archive?token=redacted#fragment"),
                         "https://example.com/archive")
        self.assertIsNone(inventory.safe_url(None))

    def test_license_hash_is_separate_from_family_hint(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            (base / "LICENSE").write_text("Permission is hereby granted, free of charge")
            (base / ".env").write_text("not read by inventory")
            records = inventory.license_files(base, base)
            self.assertEqual([r["path"] for r in records], ["LICENSE"])
            self.assertEqual(len(records[0]["sha256"]), 64)
            self.assertEqual(inventory.license_family(records, base), ["MIT-style"])

    def test_local_installed_metadata_keeps_distinct_versions(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            parent = root / "node_modules/pkg"
            child = parent / "node_modules/pkg"
            child.mkdir(parents=True)
            (parent / "package.json").write_text('{"name":"pkg","version":"1","license":"MIT"}')
            (child / "package.json").write_text('{"name":"pkg","version":"2"}')
            original = inventory.ROOT
            try:
                inventory.ROOT = root
                result = inventory.installed_js(root)
            finally:
                inventory.ROOT = original
            self.assertEqual([(i["name"], i["version"]) for i in result], [("pkg", "1"), ("pkg", "2")])
            self.assertIsNone(result[1]["license_declared"])


if __name__ == "__main__":
    unittest.main()
