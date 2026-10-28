import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const base = process.env.VIDEO_FULLSTACK_BASE_URL || 'http://127.0.0.1:4180';
const statePath = process.env.VIDEO_FULLSTACK_STATE;
if (!statePath) throw new Error('VIDEO_FULLSTACK_STATE must name a private temporary file outside artifact output');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('Bootstrap only accepts a loopback TEST stack');
if (resolve(statePath).includes(`${process.platform === 'win32' ? '\\' : '/'}test-results`)) throw new Error('Private bootstrap state must not be written into test artifacts');

let cookie;
async function api(path, data) {
  const response = await fetch(new URL(`/api${path}`, base), {
    method: data === undefined ? 'GET' : 'POST',
    headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const envelope = await response.json();
  if (!response.ok || envelope.code !== 0) throw new Error(`Bootstrap ${path} failed with HTTP ${response.status}, code ${envelope.code}`);
  const setCookie = response.headers.getSetCookie().find(value => value.startsWith('open_ai_canvas_session='));
  if (setCookie) cookie = setCookie.split(';')[0];
  return envelope.data;
}

const settings = await api('/auth/settings');
if (settings.firstUser !== true) throw new Error('Refusing bootstrap: TEST database is not clean (firstUser is false)');
const username = `ci_${randomBytes(8).toString('hex')}`;
const password = randomBytes(32).toString('base64url');
const registered = await api('/auth/register', { username, password, displayName: 'Disposable full-stack reviewer', acceptedTerms: true });
if (!registered.user?.id || registered.user.role !== 'admin' || !cookie) throw new Error('Supported first-user registration did not create the expected session');
const workspaces = await api('/intelligence/workspaces');
if (!Array.isArray(workspaces) || workspaces.length !== 1 || !workspaces[0].id || !workspaces[0].tenantId) throw new Error('Expected exactly one lazily provisioned personal workspace');
const foreignUsername = `ci_${randomBytes(8).toString('hex')}`;
const foreignPassword = randomBytes(32).toString('base64url');
const foreignUser = await api('/admin/users', { username: foreignUsername, password: foreignPassword,
  displayName: 'Disposable separate tenant', role: 'user', status: 'active' });
if (!foreignUser.user?.id) throw new Error('Supported TEST user creation failed');
await api('/auth/logout', {});
await api('/auth/login', { username: foreignUsername, password: foreignPassword });
const foreignWorkspaces = await api('/intelligence/workspaces');
if (!Array.isArray(foreignWorkspaces) || foreignWorkspaces.length !== 1 || !foreignWorkspaces[0].id || !foreignWorkspaces[0].tenantId
  || foreignWorkspaces[0].tenantId === workspaces[0].tenantId) throw new Error('Expected separate actual tenant and workspace');
await api('/auth/logout', {});
const state = { username, password, userId: registered.user.id, workspaceId: workspaces[0].id, tenantId: workspaces[0].tenantId,
  foreign: { username: foreignUsername, password: foreignPassword, userId: foreignUser.user.id,
    workspaceId: foreignWorkspaces[0].id, tenantId: foreignWorkspaces[0].tenantId } };
await mkdir(dirname(resolve(statePath)), { recursive: true, mode: 0o700 });
await writeFile(statePath, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
// Identifiers are not credentials; the runner needs them to scope configuration.
console.log(JSON.stringify({ userId: state.userId, workspaceId: state.workspaceId, tenantId: state.tenantId,
  foreign: { userId: state.foreign.userId, workspaceId: state.foreign.workspaceId, tenantId: state.foreign.tenantId },
  bootstrap: 'supported first-user registration + admin-created separate user + lazy personal workspaces; logged out' }));
