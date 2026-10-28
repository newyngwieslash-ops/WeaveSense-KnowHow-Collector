// Read only the installed image tree. Never import or execute dependency code.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const root = realpathSync(process.cwd());
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const lockBytes = readFileSync('package-lock.json');
const lock = JSON.parse(lockBytes);
const inside = path => {
  const actual = realpathSync(path);
  if (!actual.startsWith(root + '/')) throw new Error('installed_path_outside_image_app');
  return actual;
};
const notice = name => /^(licen[cs]e|notice|copying|copyright)([._-].*)?$/i.test(name);
const records = [];
for (const [path, declared] of Object.entries(lock.packages)) {
  if (!path) continue;
  if (!existsSync(resolve(path, 'package.json'))) {
    // npm ci --omit=dev can omit development and platform-optional packages,
    // never an ordinary required production dependency.
    if (!declared.dev && !declared.optional && !declared.devOptional) throw new Error('required_installed_package_missing');
    continue;
  }
  const directory = inside(path);
  const raw = readFileSync(inside(resolve(directory, 'package.json')));
  const actual = JSON.parse(raw);
  if (actual.version !== declared.version) throw new Error('installed_version_lock_mismatch');
  if (!declared.inBundle && !declared.link && !/^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(declared.integrity || '')) throw new Error('installed_integrity_missing');
  const notices = [];
  const scan = (dir, depth = 0) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = resolve(dir, entry.name);
      if (entry.isDirectory() && depth === 0 && /^(licen[cs]es|legal)$/i.test(entry.name)) scan(file, 1);
      else if ((depth || notice(entry.name)) && entry.isFile()) {
        const bytes = readFileSync(inside(file));
        notices.push({ path: relative(root, file), bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  };
  scan(directory);
  records.push({ path, name: actual.name, version: actual.version, integrity: declared.integrity || null,
    bundled: declared.inBundle === true, package_json_sha256: sha(raw), license_declared: actual.license || null,
    notices: notices.sort((a, b) => a.path.localeCompare(b.path)), license_review: 'not_performed' });
}
if (!records.length) throw new Error('installed_packages_missing');
console.log(JSON.stringify({ schema_version: 1, evidence_kind: 'observed_installed_npm', lock_sha256: sha(lockBytes),
  versions_match_lock: true, packages: records, package_bytes_integrity_verified: false,
  limits: 'npm ci checks archive integrity; this read-only observation hashes metadata/notices, not every installed package file or license compatibility.' }));
