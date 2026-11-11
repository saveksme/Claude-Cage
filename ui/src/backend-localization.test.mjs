import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("macOS exit restart compares the exact Russian backend status", async () => {
  const [backend, frontend] = await Promise.all([
    readFile(new URL("../../internal/workbench/macos_exit_policy.go", import.meta.url), "utf8"),
    readFile(new URL("./initialization.jsx", import.meta.url), "utf8"),
  ]);
  const status = backend.match(/s\.safety\.Error = "([^"]+)"/)?.[1];
  assert.ok(status);
  assert.ok(frontend.includes(`status.safety?.error === "${status}"`));
});

test("mobile pairing detects the Russian incomplete status", async () => {
  const [backend, frontend] = await Promise.all([
    readFile(new URL("../../internal/workbench/mobile_pair.go", import.meta.url), "utf8"),
    readFile(new URL("./mobile-pair-settings.jsx", import.meta.url), "utf8"),
  ]);
  const status = backend.match(/p\.status = "([^"]*не завершено[^"]*)"/)?.[1];
  assert.ok(status);
  assert.ok(frontend.includes('state.status.includes("не завершено")'));
});
