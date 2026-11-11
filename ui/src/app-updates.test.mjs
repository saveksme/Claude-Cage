import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

test("the unsigned Russian build disables upstream update checks", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { cageNativeBridge: {} };
  const root = fileURLToPath(new URL("../", import.meta.url));
  const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
  try {
    const { useAppUpdates } = await server.ssrLoadModule("/src/app-updates.jsx");
    function Probe() {
      return React.createElement("span", null, String(useAppUpdates().available));
    }
    assert.equal(renderToStaticMarkup(React.createElement(Probe)), "<span>false</span>");
  } finally {
    await server.close();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
