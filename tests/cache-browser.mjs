// Regression: a browser with old immutable modules must load a coherent new UI.
// This temporary server is test-only; its responses never enter the demo bundle.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import assert from "node:assert/strict";
let modern = false,
  runtime = "jvm",
  resetGeneration = "initial";
const assets = new Set([
  "/index.html",
  "/presenter.mjs",
  "/session.mjs",
  "/deployment.mjs",
  "/presenter.css",
]);
const root = new URL(
  "../src/main/resources/META-INF/resources/",
  import.meta.url,
);
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    res.setHeader("Cache-Control", "no-store");
    if (path === "/") {
      res.setHeader("Content-Type", "text/html");
      return res.end(
        modern
          ? await readFile(new URL("index.html", root))
          : '<script type="module" src="/presenter.mjs"></script>',
      );
    }
    if (!modern && path === "/presenter.mjs") {
      res.setHeader("Cache-Control", "public, immutable, max-age=86400");
      res.setHeader("Content-Type", "text/javascript");
      return res.end("import './session.mjs'; window.obsoleteUI=true;");
    }
    if (!modern && path === "/session.mjs") {
      res.setHeader("Cache-Control", "public, immutable, max-age=86400");
      res.setHeader("Content-Type", "text/javascript");
      return res.end("window.obsoleteModel=true;");
    }
    if (assets.has(path)) {
      res.setHeader(
        "Content-Type",
        path.endsWith(".css") ? "text/css" : "text/javascript",
      );
      return res.end(await readFile(new URL(path.slice(1), root)));
    }
    res.setHeader("Content-Type", "application/json");
    if (path === "/perf/info")
      return res.end(
        JSON.stringify({
          runtime_type: runtime,
          process_id: runtime + "-cache-test",
          vm_name: "TEST ONLY",
          available_processors: 2,
          demo_evidence: {
            status: "collected",
            data: {
              process_id: runtime + "-cache-test",
              runtime: runtime === "jvm" ? "jvm" : "native",
              reset_generation: resetGeneration,
            },
          },
        }),
      );
    if (path === "/q/health/ready")
      return res.end(JSON.stringify({ status: "UP", checks: [] }));
    if (path === "/perf/fib")
      return res.end(
        JSON.stringify({
          process_id: runtime + "-cache-test",
          input_n: 40,
          result: 102334155,
          duration_ns: 1000,
        }),
      );
    res.statusCode = 404;
    res.end("{}");
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
});
try {
  const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await page.waitForFunction(() => window.obsoleteUI && window.obsoleteModel);
  modern = true;
  await page.goto(url + "/?upgraded");
  await page.getByText("Connected · live", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.obsoleteUI), undefined);
  assert.equal(await page.evaluate(() => window.obsoleteModel), undefined);
  await page
    .getByRole("button", { name: "Save pre-load baseline", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Run first sample", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem("runtime-lab.session.v2")).runs[0].samples
        .length === 1,
  );
  await page
    .getByRole("button", {
      name: "Save post-load and switch runtime",
      exact: true,
    })
    .click();
  await page.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem("runtime-lab.session.v2")).phase === 2,
  );
  runtime = "native-image";
  await page
    .getByRole("button", { name: "Save pre-load baseline", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save post-load and compare", exact: true })
    .waitFor();
  assert.match(
    await page.locator("#computation-insight").textContent(),
    /Repeated computation comparison/,
  );
  resetGeneration = "reset-2";
  runtime = "jvm";
  await page.waitForFunction(() => {
    const s = JSON.parse(localStorage.getItem("runtime-lab.session.v2"));
    return (
      s.backendGeneration === "reset-2" &&
      s.runs.length === 1 &&
      s.runs[0].runtime === "jvm" &&
      s.runs[0].samples.length === 0
    );
  });
  assert.equal(await page.locator("#native-run").inputValue(), "");
  assert.equal(
    await page.locator("#native-run option").textContent(),
    "Not run in this session",
  );
  await page
    .getByRole("button", { name: "Save pre-load baseline", exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Warm browser-cache regression passed: new entry + model modules, both post-load buttons, and insight rendering.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
