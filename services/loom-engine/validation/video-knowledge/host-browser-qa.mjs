// Actual React host + Go cookie session + Loom API fixture. Never substitutes a
// static HTML mock, and never sends a platform cookie or a model request.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const base = process.env.VIDEO_QA_HOST_URL ?? "http://127.0.0.1:13000";
const output = process.env.VIDEO_QA_OUTPUT ?? "/workspace/shared/knowhow-qa";
const password = process.env.VIDEO_QA_PASSWORD;
if (!password) throw new Error("VIDEO_QA_PASSWORD synthetic fixture password required");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [], requests = [], checks = [];
page.on("pageerror", error => errors.push(error.message));
page.on("response", response => { if (response.url().includes("/api/") && response.status() >= 400) requests.push({ url: response.url(), status: response.status() }); });
const api = async (method, path, data, headers = {}) => {
  const response = await context.request.fetch(base + "/api" + path, { method, data, headers });
  const value = await response.json();
  assert.ok(response.ok() && value.code === 0, `${method} ${path}: ${response.status()} ${JSON.stringify(value)}`);
  return value.data;
};
try {
  const settings = await api("GET", "/auth/settings");
  if (settings.firstUser) await api("POST", "/auth/register", { username: "qa_host_20261026", displayName: "QA synthetic user", password, acceptedTerms: true });
  await api("POST", "/auth/logout", {});
  await page.goto(base + "/login?next=%2Fintelligence%2Fdomains");
  await page.locator("#login-account").fill("qa_host_20261026");
  await page.locator("#login-password").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL("**/intelligence/domains", { timeout: 30_000 });
  await page.getByRole("button", { name: "新建知识域", exact: true }).waitFor({ state: "visible" });
  const workspaces = await api("GET", "/intelligence/workspaces");
  const workspace = workspaces[0].id;
  const headers = { "X-Workspace-Id": workspace, "X-Idempotency-Key": "qa-browser" };
  checks.push("real registration, UI login and workspace-scoped session");

  await page.getByRole("button", { name: "新建知识域", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "新建知识域", exact: true }).click();
  await page.getByLabel("领域名称", { exact: true }).fill("QA 浏览器研究领域");
  await page.getByLabel("目标问题（每行一项）", { exact: true }).fill("合成材料表达了什么？\n是否缺少必要证据？");
  await page.getByRole("button", { name: "保存新版本", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const profiles = await api("GET", "/intelligence/video/profiles", undefined, headers);
  assert.ok(profiles.items.some(x => x.name === "QA 浏览器研究领域"));
  const profile = profiles.items.find(x => x.name === "QA 浏览器研究领域");
  checks.push("profile modal cancellation/reopen, actual API persistence and frozen version");
  await page.screenshot({ path: output + "/host-domains-desktop.png", fullPage: true });

  const source = await api("POST", "/intelligence/sources", { kind: "bilibili", title: "QA 合成来源（不访问平台）", url: "https://www.bilibili.com/video/BV1QA0000001?p=1", config: { source_type: "video", native_id: "BV1QA0000001", part_id: "1", profile_id: profile.id, profile_version: profile.version, usage_basis: "Synthetic browser fixture, no platform acquisition", allowed_uses: ["knowledge"] } }, headers);
  const job = await api("POST", "/intelligence/video/jobs", { source_id: source.id, native_id: "BV1QA0000001", profile_id: profile.id, profile_version: profile.version }, { ...headers, "X-Idempotency-Key": "qa-browser-job" });
  await page.goto(base + "/intelligence/video-jobs");
  await page.getByRole("button", { name: job.video_job_id, exact: true }).click();
  await page.getByRole("button", { name: "请求取消", exact: true }).click();
  await page.getByLabel("取消理由").fill("Independent fixture cancellation");
  await page.getByRole("button", { name: "确认取消", exact: true }).click();
  await page.getByRole("dialog").filter({ hasText: "请求取消此视频任务" }).waitFor({ state: "hidden" });
  const cancelled = await api("GET", "/intelligence/video/jobs/" + job.video_job_id, undefined, headers);
  assert.equal(cancelled.state, "cancelled");
  await page.reload();
  await page.getByRole("button", { name: job.video_job_id, exact: true }).waitFor();
  assert.ok((await page.locator("body").innerText()).includes("已取消"));
  checks.push("real queued job, details, cancel command and reload persistence");
  await page.screenshot({ path: output + "/host-video-jobs-desktop.png", fullPage: true });

  for (const route of ["sources", "video-knowledge", "video-skills", "mcp"]) {
    await page.goto(base + "/intelligence/" + route);
    await page.waitForTimeout(700);
    assert.ok((await page.locator("body").innerText()).length > 50, route + " must render visible content");
    await page.screenshot({ path: output + `/host-${route}-desktop.png`, fullPage: true });
    checks.push("actual host route renders: " + route);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + "/intelligence/video-jobs");
  await page.getByRole("button", { name: job.video_job_id, exact: true }).waitFor();
  await page.screenshot({ path: output + "/host-video-jobs-mobile.png", fullPage: true });
  const overflow = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth }));
  checks.push("mobile actual host route renders");
  const result = { mode: "actual-host-with-synthetic-auth-and-Loom-PGlite", checks, errors, requests, overflow, workspace_id: workspace, operation_id: job.operation_id, video_job_id: job.video_job_id,
    not_executed: ["live platforms", "actual ASR model quality", "industry review", "real Agent model", "seven-day pilot", "production deployment"] };
  await writeFile(output + "/host-browser-qa.json", JSON.stringify(result, null, 2));
  assert.deepEqual(errors, [], "uncaught browser errors");
  assert.deepEqual(requests, [], "unexpected failing host API responses");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await page.screenshot({ path: output + "/host-failure.png", fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ failure: String(error), errors, requests, body: (await page.locator("body").innerText()).slice(0, 10000) }, null, 2));
  throw error;
} finally { await browser.close(); }
