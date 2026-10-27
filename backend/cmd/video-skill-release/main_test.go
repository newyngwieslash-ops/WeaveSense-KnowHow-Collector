package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestReleaseImmutableHistoryAndRetry(t *testing.T) {
	root := t.TempDir()
	for _, version := range []string{"1.0.0", "1.1.0", "1.0.0"} {
		if err := writeRelease(root, "method-test", version, []byte(version), []byte("manifest-"+version)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writeRelease(root, "method-test", "1.0.0", []byte("conflict"), []byte("changed")); err == nil {
		t.Fatal("overwrote immutable release")
	}
	for _, version := range []string{"1.0.0", "1.1.0"} {
		got, err := os.ReadFile(filepath.Join(root, "method-test", version+".json"))
		if err != nil || string(got) != version {
			t.Fatalf("history lost: %q %v", got, err)
		}
	}
}

func TestReleaseRejectsEscapeSymlinkAndUnknownLock(t *testing.T) {
	root := t.TempDir()
	for _, id := range []string{"../escape", "/escape", "", ".hidden"} {
		if err := writeRelease(root, id, "1.0.0", nil, nil); err == nil {
			t.Fatal("accepted path escape")
		}
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	if err := writeRelease(root, "linked", "1.0.0", nil, nil); err == nil {
		t.Fatal("followed symlink")
	}
	if err := os.MkdirAll(filepath.Join(root, "locked", ".release.lock"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := writeRelease(root, "locked", "1.0.0", nil, nil); err == nil {
		t.Fatal("stole unknown-outcome lock")
	}
}

func TestReleaseRecoversManifestOnlyCheckpoint(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "method"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "method", "1.0.0.manifest.json"), []byte("manifest"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := writeRelease(root, "method", "1.0.0", []byte("pack"), []byte("manifest")); err != nil {
		t.Fatal(err)
	}
}

func TestReleaseCLIRejectsUnapprovedInputWithoutWriting(t *testing.T) {
	root := t.TempDir()
	input := filepath.Join(root, "private.json")
	if err := os.WriteFile(input, []byte(`{"state":"candidate"}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := run([]string{"--input", input, "--archive-root", root}, &out); err == nil {
		t.Fatal("accepted unapproved candidate")
	}
	if out.Len() != 0 {
		t.Fatal("reported release success")
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 {
		t.Fatal("wrote unapproved artifact")
	}
}
