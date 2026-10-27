import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const cwd = fileURLToPath(new URL("../", import.meta.url));

function suite(...files: string[]) {
    const result = spawnSync(process.execPath, ["test", ...files], { cwd, encoding: "utf8", timeout: 20_000 });
    if (result.status !== 0) throw new Error(`${files.join(", ")}: ${result.error?.message || result.stderr.slice(-2500)}`);
    expect(result.stdout + result.stderr).not.toContain("(fail)");
}

test("session tests leave a subsequent protected API usable in the same process", () => {
    suite("test/cross-tab-session-cache.test.ts", "test/intelligence-member-api.test.ts");
}, 25_000);

test("native file paths and line endings execute the real entry and ownership checks", () => {
    suite("test/application-bootstrap.test.mjs", "test/agent-launcher-position.test.mjs", "test/http-ownership.test.ts", "test/welcome-title.test.mjs");
}, 25_000);

test("temporary Agent protocol modules resolve their real session dependency", () => {
    suite("test/agent-api-reliability.test.ts");
}, 25_000);

test("Bun executes a real module through a file URL containing spaces and Chinese", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-entry-中文 space-"));
    try {
        const entry = join(dir, "入口.ts");
        const modulePath = fileURLToPath(new URL("../src/lib/canvas/agent-launcher-position.ts", import.meta.url));
        writeFileSync(entry, `export { clampAgentLauncherPosition } from ${JSON.stringify(modulePath)};`);
        // Bun 1.3.9 can retain the temporary entry's missing tsconfig after build,
        // breaking later @/ imports in this process. Keep that build isolated.
        const script = `
            import { fileURLToPath } from "node:url";
            import { runInNewContext } from "node:vm";
            const build = await Bun.build({ entrypoints: [fileURLToPath(${JSON.stringify(pathToFileURL(entry).href)})], target: "browser", format: "cjs" });
            if (!build.success) throw new AggregateError(build.logs, "Unicode-path build failed");
            const module = { exports: {} };
            runInNewContext(await build.outputs[0].text(), { module, exports: module.exports });
            process.stdout.write(JSON.stringify(module.exports.clampAgentLauncherPosition({ right: -1, bottom: -1 }, { width: 1280, height: 800 })));
        `;
        const result = spawnSync(process.execPath, ["--eval", script], { cwd, encoding: "utf8", timeout: 20_000 });
        if (result.status !== 0) throw new Error(result.error?.message || result.stderr);
        expect(JSON.parse(result.stdout)).toEqual({ right: 20, bottom: 20 });
        const alias = "@/lib/asset-category";
        expect((await import(alias)).normalizeAssetCategory("weapon")).toBe("prop");
    } finally {
        expect(dirname(dir)).toBe(resolve(tmpdir()));
        expect(basename(dir)).toStartWith("canvas-entry-");
        rmSync(dir, { recursive: true, force: true });
    }
});
