import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
});
await mkdir("test-results", { recursive: true });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
});
const page = await context.newPage(),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let benchmarkRequests = 0;
page.on("request", (r) => {
  if (r.url().includes("/perf/fib")) benchmarkRequests++;
});
if (!process.argv.includes("--fixtures-only")) {
  try {
    await page.goto("http://localhost:8080");
    await page.getByText("Connected · live", { exact: true }).waitFor();
    assert.equal(benchmarkRequests, 0);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.ok(
      await page
        .locator("footer")
        .evaluate((e) => e.getBoundingClientRect().bottom <= 1080),
    );
    await page.screenshot({ path: "test-results/start-dark.png" });
    await page
      .getByRole("button", { name: "Light theme", exact: true })
      .click();
    await page.screenshot({ path: "test-results/start-light.png" });
    await page.reload();
    await page.getByText("Connected · live", { exact: true }).waitFor();
    assert.equal(
      await page.locator("html").getAttribute("data-theme"),
      "light",
    );
    await page
      .getByRole("button", { name: "Save baseline snapshot", exact: true })
      .click();
    assert.equal(benchmarkRequests, 0);
    await page
      .getByRole("button", { name: "Run first sample", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .getElementById("batch-status")
        .textContent.includes("1/1 successful"),
    );
    await page.getByRole("button", { name: "Run 5 more", exact: true }).click();
    await page.waitForFunction(() =>
      document
        .getElementById("batch-status")
        .textContent.includes("5/5 successful"),
    );
    assert.equal(benchmarkRequests, 6);
    await page.screenshot({ path: "test-results/load-light.png" });
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("runtime-lab.session.v1")),
    );
    assert.equal(saved.runs[0].samples.length, 6);
    await page
      .getByRole("button", {
        name: "Save baseline and switch runtime",
        exact: true,
      })
      .click();
    if (process.argv.includes("--restart")) {
      console.log("READY_FOR_BACKEND_STOP");
      await page
        .getByText("Disconnected / reconnecting", { exact: true })
        .waitFor({ timeout: 60000 });
      await page.screenshot({ path: "test-results/disconnected.png" });
      console.log("DISCONNECTED_CONFIRMED");
      await page
        .getByText("Connected · live", { exact: true })
        .waitFor({ timeout: 60000 });
      const after = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("runtime-lab.session.v1")),
      );
      assert.ok(after.runs.length >= 2);
      assert.equal(after.runs[0].samples.length, 6);
      assert.notEqual(after.runs[0].id, after.runs.at(-1).id);
      console.log("REAL_BACKEND_RECONNECT_PASSED");
    } else {
      await context.setOffline(true);
      await page
        .getByText("Disconnected / reconnecting", { exact: true })
        .waitFor({ timeout: 25000 });
      await page.screenshot({ path: "test-results/disconnected.png" });
      await context.setOffline(false);
      await page
        .getByText("Connected · live", { exact: true })
        .waitFor({ timeout: 25000 });
    }
    await page.reload();
    await page.getByText("Connected · live", { exact: true }).waitFor();
    const restored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("runtime-lab.session.v1")),
    );
    assert.equal(restored.runs[0].samples.length, 6);
    assert.equal(benchmarkRequests, 6);
    console.log(
      "Live 1920x1080 SPA: themes, baseline, six deliberate calls, persistence and disconnect/reconnect passed",
    );
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
} else {
  await context.close();
}
// All following responses are isolated test fixtures, never bundled or used by the live page.
const c = await browser.newContext({ viewport: { width: 1920, height: 1080 } }),
  p = await c.newPage();
let runtime = "jvm",
  id = "test-jvm",
  calls = 0,
  failAt = 4,
  backendReadsWhileComputing = 0,
  computing = false;
await p.route("**/perf/info", (route) => {
  if (computing) backendReadsWhileComputing++;
  return route.fulfill({
    json: {
      runtime_type: runtime,
      process_id: id,
      vm_name: "TEST ONLY",
      uptime_ms: 100,
      available_processors: 2,
      heap_used_mb: null,
      heap_max_mb: -1,
      non_heap_used_mb: null,
    },
  });
});
await p.route("**/q/health/ready", (route) =>
  route.fulfill({ json: { status: "UP", checks: [] } }),
);
await p.route("**/perf/fib?n=40", async (route) => {
  computing = true;
  calls++;
  await new Promise((r) => setTimeout(r, 150));
  computing = false;
  if (calls === failAt)
    return route.fulfill({ status: 500, body: "test failure" });
  return route.fulfill({
    json: {
      input_n: 40,
      result: runtime === "jvm" ? 102334155 : 999,
      duration_ns: 1000000,
      process_id: id,
    },
  });
});
try {
  await p.goto("http://localhost:8080");
  await p.getByText("Connected · live", { exact: true }).waitFor();
  assert.ok(
    await p
      .locator("#metrics")
      .textContent()
      .then((t) => t.includes("Unavailable")),
  );
  await p
    .getByRole("button", { name: "Save baseline snapshot", exact: true })
    .click();
  await p
    .getByRole("button", { name: "Run first sample", exact: true })
    .click();
  await p.waitForFunction(() =>
    document
      .getElementById("batch-status")
      .textContent.includes("1/1 successful"),
  );
  await p.getByRole("button", { name: "Run 5 more", exact: true }).click();
  assert.equal(
    await p
      .getByRole("button", { name: "Run first sample", exact: true })
      .isDisabled(),
    true,
  );
  await p.waitForFunction(() =>
    document
      .getElementById("batch-status")
      .textContent.includes("2/5 successful"),
  );
  let data = await p.evaluate(() =>
    JSON.parse(localStorage.getItem("runtime-lab.session.v1")),
  );
  assert.equal(data.runs[0].samples.length, 3);
  assert.equal(data.runs[0].batches[1].error, "HTTP 500");
  assert.equal(backendReadsWhileComputing, 0);
  runtime = "native-image";
  id = "test-native";
  failAt = -1;
  await p.waitForFunction(
    () => document.getElementById("runtime").textContent === "Native Image",
  );
  await p
    .getByRole("button", { name: "Run first sample", exact: true })
    .click();
  await p.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem("runtime-lab.session.v1")).runs.at(-1)
        .samples.length === 1,
  );
  await p.getByRole("button", { name: "04  Compare", exact: true }).click();
  assert.ok(
    (await p.locator("#comparison").textContent()).includes(
      "Input or result mismatch",
    ),
  );
  assert.ok((await p.locator("#warnings").textContent()).includes("unknown"));
  await p.screenshot({ path: "test-results/compare-test-fixture.png" });
  const compareBottom = await p
    .locator("footer")
    .evaluate((e) => e.getBoundingClientRect().bottom);
  assert.ok(compareBottom <= 1080, `Compare footer bottom ${compareBottom}`);
  await p.locator("#comparison details").evaluate((e) => (e.open = true));
  await p.waitForTimeout(1500);
  assert.equal(
    await p.locator("#comparison details").evaluate((e) => e.open),
    true,
  );
  await p.getByRole("button", { name: "Fullscreen ↗", exact: true }).click();
  await p.waitForFunction(() => !!document.fullscreenElement);
  await p.getByRole("button", { name: "Fullscreen ↗", exact: true }).click();
  await p.waitForFunction(() => !document.fullscreenElement);
  data = await p.evaluate(() =>
    JSON.parse(localStorage.getItem("runtime-lab.session.v1")),
  );
  assert.equal(data.runs.length, 2);
  assert.equal(data.runs[0].samples.length, 3);
  const downloadPromise = p.waitForEvent("download");
  await p.locator("#details").evaluate((e) => (e.open = true));
  await p
    .getByRole("button", { name: "Export complete session", exact: true })
    .click();
  const download = await downloadPromise;
  const file = await download.path();
  await p.locator("#import").setInputFiles(file);
  await p.waitForFunction(() =>
    document
      .getElementById("notice")
      .textContent.includes("Imported saved session"),
  );
  assert.equal(
    (
      await p.evaluate(() =>
        JSON.parse(localStorage.getItem("runtime-lab.session.v1")),
      )
    ).runs[0].samples.length,
    3,
  );
  console.log(
    "Isolated browser failure tests: partial batch, polling suspension, runtime change, unknown values, result mismatch, export/import passed",
  );
} finally {
  await c.close();
  await browser.close();
}
