// video-skill-release prepares reviewed native Skill source artifacts. It does
// not publish, build, deploy, approve a candidate, or install a workspace Skill.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"yingce/backend/internal/flow"
)

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "video-skill-release:", err)
		os.Exit(1)
	}
}

func run(args []string, out io.Writer) error {
	f := flag.NewFlagSet("video-skill-release", flag.ContinueOnError)
	input := f.String("input", "", "private authorized Loom export JSON; never commit this input")
	root := f.String("archive-root", "", "existing backend/internal/flow/skillpacks/releases directory")
	check := f.Bool("check", false, "validate only; write no source artifacts")
	if err := f.Parse(args); err != nil {
		return err
	}
	if *input == "" || f.NArg() != 0 || (!*check && *root == "") {
		return errors.New("require --input and either --check or --archive-root")
	}
	file, err := os.Open(*input)
	if err != nil {
		return err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, (16<<20)+1))
	if err != nil {
		return err
	}
	artifact, err := flow.PrepareVideoSkillRelease(raw)
	if err != nil {
		return err
	}
	if !*check {
		if err = writeRelease(*root, artifact.Pack.ID, artifact.Pack.Version, artifact.PackJSON, artifact.ManifestJSON); err != nil {
			return err
		}
	}
	return json.NewEncoder(out).Encode(map[string]any{
		"validated": true, "source_written": !*check, "deployed": false, "installed": false,
		"pack_id": artifact.Pack.ID, "version": artifact.Pack.Version,
		"native_skill_hash": artifact.Manifest.NativeSkillHash,
		"pack_sha256":       artifact.Manifest.PackSHA256,
		"next_step":         "review source diff, run tests, build host, verify runtime deployment receipt, then explicit CAS workspace install",
	})
}

var safeID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$`)
var safeVersion = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$`)

func writeRelease(dir, id, version string, pack, manifest []byte) error {
	if !safeID.MatchString(id) || !safeVersion.MatchString(version) {
		return errors.New("invalid archive identity")
	}
	// The selected source directory must already exist and must not be a symlink.
	// OpenRoot also confines operations if an ancestor is changed concurrently.
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("archive root must be a real directory")
	}
	r, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer r.Close()
	if err = r.Mkdir(id, 0755); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	info, err = r.Lstat(id)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("pack directory must not be a symlink")
	}
	// Never steal a stale lock: its previous write may have an unknown outcome.
	lock := filepath.Join(id, ".release.lock")
	if err = r.Mkdir(lock, 0700); err != nil {
		return fmt.Errorf("release writer busy or previous outcome unknown: %w", err)
	}
	defer r.Remove(lock)
	packPath := filepath.Join(id, version+".json")
	manifestPath := filepath.Join(id, version+".manifest.json")
	// Preflight both files before changing either. Identical retries are safe;
	// conflicts never overwrite either old release or its lineage.
	for name, expected := range map[string][]byte{packPath: pack, manifestPath: manifest} {
		if err = sameOrAbsent(r, name, expected); err != nil {
			return err
		}
	}
	// A crash after the manifest is safe: the loader ignores orphan manifests.
	// The pack appears only after its complete fsynced lineage is durable.
	if err = writeImmutable(r, manifestPath, manifest); err != nil {
		return err
	}
	if err = writeImmutable(r, packPath, pack); err != nil {
		return err
	}
	return nil
}

func sameOrAbsent(r *os.Root, name string, expected []byte) error {
	info, err := r.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() != int64(len(expected)) {
		return fmt.Errorf("immutable source conflict: %s", name)
	}
	f, err := r.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, int64(len(expected))+1))
	if err != nil {
		return err
	}
	if !bytes.Equal(raw, expected) {
		return fmt.Errorf("immutable source conflict: %s", name)
	}
	return nil
}

func writeImmutable(r *os.Root, name string, content []byte) error {
	if _, err := r.Lstat(name); err == nil {
		return sameOrAbsent(r, name, content)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	tmp := filepath.Join(filepath.Dir(name), ".release-"+hex.EncodeToString(nonce[:])+".pending")
	f, err := r.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return err
	}
	defer r.Remove(tmp)
	_, err = io.Copy(f, bytes.NewReader(content))
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	// Link is an atomic no-replace publication, unlike Rename. A platform that
	// cannot provide it fails safely rather than weakening immutable history.
	if err = r.Link(tmp, name); err != nil {
		return err
	}
	dir, err := r.Open(filepath.Dir(name))
	if err != nil {
		return err
	}
	defer dir.Close()
	if err = dir.Sync(); err != nil {
		return fmt.Errorf("source published but directory durability uncertain (%s): %w", strings.TrimSpace(name), err)
	}
	return nil
}
