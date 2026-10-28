// Probe the real nginx -> Go session path without any Cookie or auth bypass.
const base = process.env.VIDEO_FULLSTACK_BASE_URL;
if (!base || new URL(base).hostname !== '127.0.0.1') throw new Error('loopback_test_origin_required');
const attempts = [];
const deadline = Date.now() + 60000;
let ready = false;
while (Date.now() < deadline && !ready) {
  try {
    const response = await fetch(`${base}/api/auth/session`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    const data = await response.json();
    ready = response.status === 200 && data.code === 0 && data.data?.user === null;
    attempts.push({ status: response.status, code: data.code, unauthenticated_session_ready: ready });
  } catch { attempts.push({ transport_or_json_failure: true }); }
  if (!ready) await new Promise(resolve => setTimeout(resolve, 1000));
}
console.log(JSON.stringify({ ready, attempts }));
process.exitCode = ready ? 0 : 1;
