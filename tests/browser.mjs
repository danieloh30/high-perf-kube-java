import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const BASE_URL = process.env.DEMO_TEST_URL || "http://localhost:8080";
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
    await page.goto(BASE_URL);
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
      .getByRole("button", { name: "Save pre-load baseline", exact: true })
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
      JSON.parse(localStorage.getItem("runtime-lab.session.v2")),
    );
    assert.equal(saved.runs[0].samples.length, 6);
    await page
      .getByRole("button", {
        name: "Save post-load and switch runtime",
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
        JSON.parse(localStorage.getItem("runtime-lab.session.v2")),
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
      JSON.parse(localStorage.getItem("runtime-lab.session.v2")),
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
  await p.goto(BASE_URL);
  await p.getByText("Connected · live", { exact: true }).waitFor();
  assert.ok(
    await p
      .locator("#metrics")
      .textContent()
      .then((t) => t.includes("Unavailable")),
  );
  await p
    .getByRole("button", { name: "Save pre-load baseline", exact: true })
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
    JSON.parse(localStorage.getItem("runtime-lab.session.v2")),
  );
  assert.equal(data.runs[0].samples.length, 3);
  assert.equal(data.runs[0].batches[1].error, "HTTP 500");
  assert.equal(backendReadsWhileComputing, 0);
  await p
    .getByRole("button", {
      name: "Save post-load and switch runtime",
      exact: true,
    })
    .click();
  await p.waitForFunction(() =>
    JSON.parse(
      localStorage.getItem("runtime-lab.session.v2"),
    ).runs[0].snapshots.some((x) => x.kind === "post-load"),
  );
  runtime = "native-image";
  id = "test-native";
  failAt = -1;
  await p.waitForFunction(
    () => document.getElementById("runtime").textContent === "Native Image",
  );
  await p
    .getByRole("button", { name: "Save pre-load baseline", exact: true })
    .click();
  await p
    .getByRole("button", { name: "Run first sample", exact: true })
    .click();
  await p.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem("runtime-lab.session.v2")).runs.at(-1)
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
    JSON.parse(localStorage.getItem("runtime-lab.session.v2")),
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
        JSON.parse(localStorage.getItem("runtime-lab.session.v2")),
      )
    ).runs[0].samples.length,
    3,
  );
  assert.ok(
    (await p.locator("#computation-insight").textContent()).includes(
      "unavailable",
    ),
  );
  p.once("dialog", (dialog) => dialog.accept());
  await p
    .getByRole("button", { name: "Reset comparison session", exact: true })
    .click();
  await p.waitForFunction(() =>
    JSON.parse(localStorage.getItem("runtime-lab.session.v2")).runs.every(
      (r) => r.samples.length === 0,
    ),
  );
  assert.equal(
    await p.evaluate(() => localStorage.getItem("runtime-lab.session.v1")),
    null,
  );
  console.log(
    "Isolated browser failure tests: partial batch, polling suspension, runtime change, unknown values, result mismatch, export/import passed",
  );
} finally {
  await c.close();
}

// Positive two-runtime collection scenario: fixtures remain in this isolated context only.
const evidenceContext = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
});
const e = await evidenceContext.newPage();
let evidenceRuntime = "jvm",
  clusterEnvironment = false;
const counts = {
  jvm: { fib: 0, primes: 0 },
  "native-image": { fib: 0, primes: 0 },
};
const processId = () => `evidence-test-${evidenceRuntime}`;
await e.route("**/perf/info", (route) => {
  const total = counts[evidenceRuntime].fib + counts[evidenceRuntime].primes;
  return route.fulfill({
    json: {
      runtime_type: evidenceRuntime,
      execution_environment: {
        mode: clusterEnvironment ? "kubernetes" : "unconfirmed",
      },
      process_id: processId(),
      vm_name: "TEST FIXTURE ONLY",
      available_processors: 2,
      uptime_ms: 500,
      heap_used_mb: total ? 34 : 12,
      heap_max_mb: 256,
      non_heap_used_mb: 20,
      process_rss: {
        status: "collected",
        value_mib: total ? 100 : 80,
        source: "TEST RSS",
        timestamp: "2026-11-05T00:00:00Z",
      },
      container_memory: {
        status: "not-applicable",
        reason: "TEST host process",
      },
      demo_evidence: {
        status: "collected",
        data: {
          process_id: processId(),
          runtime: evidenceRuntime === "jvm" ? "jvm" : "native",
          revision: "TEST-REVISION",
          source_hash: "TEST-HASH",
          dirty: false,
          environment_mode: "host",
          settings: {
            cpu: "2",
            heap: "64m/256m",
            memory: "none",
            flags: "same relevant flags",
            environment: "test environment",
          },
          costs: {
            build_seconds: 12,
            peak_build_mib: 100,
            artifact_bytes: 1024,
            image_bytes: null,
            source: "TEST build log",
            timestamp: "2026-11-05T00:00:00Z",
          },
          image: {
            version: 1,
            builder: "quarkus-container-image-jib",
            runtime: "jvm",
            image: "quay.io/danieloh30/high-perf-java:1.0",
            platform: "linux/amd64",
            digest: "sha256:" + "a".repeat(64),
            published: true,
            image_bytes: 1234,
            build_seconds: 2,
            source_hash: "TEST-HASH",
            source: "TEST ONLY Jib build",
            timestamp: "2026-11-05T00:00:00Z",
            image_size_source: "TEST ONLY local image size",
          },
          scale: {
            kind: "scale",
            status: "complete",
            namespace: "test",
            deployment: "test",
            from_replicas: 1,
            target: 100,
            duration_ms: 4000,
            source: "TEST ONLY oc fixture",
            timestamp: "2026-11-05T00:00:00Z",
            boundary: "TEST ONLY scale observation",
            timeline: [
              {
                elapsed_ms: 4000,
                ready: 100,
                available: 100,
                pending: 0,
                terminating: 0,
              },
            ],
          },
          launch: {
            duration_ms: 450,
            source: "TEST terminal monotonic clock",
            timestamp: "2026-11-05T00:00:00Z",
            polling_interval_ms: 50,
          },
        },
      },
    },
  });
});
await e.route("**/q/health/ready", (route) =>
  route.fulfill({
    json: {
      status: "UP",
      checks: [
        {
          name: "app-readiness",
          data: { process_id: processId(), startup_time_ms: 100 },
        },
      ],
    },
  }),
);
for (const [benchmark, url] of [
  ["fib", "**/perf/fib?n=40"],
  ["primes", "**/perf/primes?limit=1000000"],
])
  await e.route(url, (route) => {
    counts[evidenceRuntime][benchmark]++;
    return route.fulfill({
      json: {
        process_id: processId(),
        duration_ns:
          evidenceRuntime === "jvm"
            ? benchmark === "primes"
              ? 400000
              : 1000000
            : 800000,
        ...(benchmark === "fib"
          ? { input_n: 40, result: 102334155 }
          : { limit: 1000000, prime_count: 78498, largest_prime: 999983 }),
      },
    });
  });
async function collect(workload) {
  await e.locator("#load-benchmark").selectOption(workload);
  await e
    .getByRole("button", { name: "Run first sample", exact: true })
    .click();
  await e.waitForFunction(
    ({ id, workload }) =>
      JSON.parse(localStorage.getItem("runtime-lab.session.v2"))
        .runs.find((r) => r.id === id)
        .samples.filter((x) => x.benchmark === workload).length === 1,
    { id: processId(), workload },
  );
  await e.getByRole("button", { name: "Run 5 more", exact: true }).click();
  await e.waitForFunction(
    ({ id, workload }) =>
      JSON.parse(localStorage.getItem("runtime-lab.session.v2"))
        .runs.find((r) => r.id === id)
        .samples.filter((x) => x.benchmark === workload).length === 6,
    { id: processId(), workload },
  );
}
try {
  await e.goto(BASE_URL);
  await e.getByText("Connected · live", { exact: true }).waitFor();
  await e
    .getByRole("button", { name: "Save pre-load baseline", exact: true })
    .click();
  await collect("fib");
  await collect("primes");
  await e
    .getByRole("button", {
      name: "Save post-load and switch runtime",
      exact: true,
    })
    .click();
  await e.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem("runtime-lab.session.v2")).phase === 2,
  );
  evidenceRuntime = "native-image";
  await e.waitForFunction(
    () => document.getElementById("runtime").textContent === "Native Image",
  );
  await e
    .getByRole("button", { name: "Save pre-load baseline", exact: true })
    .click();
  await collect("fib");
  await collect("primes");
  await e
    .getByRole("button", { name: "Save post-load and compare", exact: true })
    .click();
  await e.locator("#compare-benchmark").selectOption("fib");
  assert.match(
    await e.locator("#computation-insight").textContent(),
    /20.0% less/,
  );
  assert.equal(
    (await e.locator("#warnings").textContent()).includes("unknown"),
    false,
  );
  const paired = await e.evaluate(
    () => JSON.parse(localStorage.getItem("runtime-lab.session.v2")).runs,
  );
  assert.equal(paired.length, 2);
  for (const run of paired) {
    assert.equal(run.snapshots[0].info.heap_used_mb, 12);
    assert.equal(run.snapshots[1].info.heap_used_mb, 34);
    assert.equal(run.costs.artifact_bytes, 1024);
  }
  await e.screenshot({ path: "test-results/insights-test-fixture.png" });
  assert.ok(
    await e
      .locator("footer")
      .evaluate((n) => n.getBoundingClientRect().bottom <= 1080),
  );
  await e.locator("#comparison details").evaluate((n) => (n.open = true));
  await e.locator("#observation-phase").focus();
  await e.evaluate(
    () =>
      (window.originalPhaseSelect =
        document.getElementById("observation-phase")),
  );
  await e.waitForTimeout(2600);
  assert.equal(
    await e.evaluate(
      () =>
        window.originalPhaseSelect ===
        document.getElementById("observation-phase"),
    ),
    true,
  );
  assert.match(await e.locator("#comparison").textContent(), /TEST RSS/);
  assert.match(await e.locator("#comparison").textContent(), /TEST build log/);
  assert.match(await e.locator("#comparison").textContent(), /Not applicable/);
  await e.locator("#observation-phase").selectOption("post-load");
  assert.match(
    await e.locator("#comparison").textContent(),
    /Post-load snapshot/,
  );
  assert.match(await e.locator("#comparison").textContent(), /34/);
  await e.reload();
  await e.getByText("Connected · live", { exact: true }).waitFor();
  await e.locator("#comparison details").evaluate((n) => (n.open = true));
  assert.equal(await e.locator("#observation-phase").inputValue(), "post-load");
  assert.match(
    await e.locator("#insight-workload").textContent(),
    /recursive calls/,
  );
  await e
    .getByRole("button", { name: "05  Containerize", exact: true })
    .click();
  await e.waitForFunction(() =>
    document
      .getElementById("image-evidence")
      .textContent.includes("Recorded Jib build"),
  );
  assert.match(
    await e.locator("#image-evidence").textContent(),
    /TEST ONLY Jib build/,
  );
  assert.equal(await e.locator("body").getAttribute("data-phase"), "4");
  assert.equal(
    await e.locator(".extension-highlight code").textContent(),
    "quarkus-container-image-jib",
  );
  await e.screenshot({ path: "test-results/containerize-test-fixture.png" });
  await e
    .getByRole("button", { name: "Continue to Kubernetes", exact: true })
    .click();
  await e
    .locator("#openshift-console")
    .fill("https://console.example/topology/ns/test");
  await e.locator("#openshift-console").press("Tab");
  assert.equal(
    await e.locator("#open-openshift").getAttribute("href"),
    "https://console.example/topology/ns/test",
  );
  await e.locator("#application-url").fill("https://app.example");
  await e.locator("#application-url").press("Tab");
  await e.route("https://app.example/q/health/ready", (route) =>
    route.fulfill({
      json: { status: "UP" },
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await e
    .getByRole("button", { name: "Check deployed app", exact: true })
    .click();
  await e.waitForFunction(() =>
    document
      .getElementById("route-status")
      .textContent.includes("readiness UP"),
  );
  assert.match(
    await e.locator("#scale-out-command").textContent(),
    /demo\.sh scale 100/,
  );
  assert.match(await e.locator("#scale-evidence").textContent(), /1 → 100/);
  assert.equal(
    await e.locator("#scale-terminal").evaluate((n) => n.open),
    false,
  );
  assert.equal(await e.locator("#direct-scale-out").isVisible(), true);
  await e
    .locator("#scale-out-command")
    .evaluate((n) => (n.closest("details").open = true));
  let scaleRequests = [];
  await e.route("**/demo/cluster-control", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        token: "TEST-ONLY-CAPABILITY",
        namespace: "high-perf-java",
        deployment: "high-perf-java",
        running: false,
      },
    }),
  );
  await e.route("**/demo/cluster-control/scale", (route) => {
    scaleRequests.push(route.request().postDataJSON());
    return route.fulfill({ status: 202, json: { status: "accepted" } });
  });
  await e
    .getByRole("button", { name: "Check local cluster control", exact: true })
    .click();
  e.on("dialog", (dialog) => dialog.accept());
  await e
    .getByRole("button", { name: "Scale to 100 now", exact: true })
    .click();
  assert.deepEqual(scaleRequests, [{ replicas: 100 }]);
  await e.getByRole("button", { name: "Scale to 1 now", exact: true }).click();
  assert.deepEqual(scaleRequests, [{ replicas: 100 }, { replicas: 1 }]);
  assert.equal(
    (
      await e.evaluate(() => localStorage.getItem("runtime-lab.session.v2"))
    ).includes("TEST-ONLY-CAPABILITY"),
    false,
  );
  await e.locator("#scale-terminal").evaluate((n) => (n.open = false));
  assert.match(
    await e.locator("#control-state").textContent(),
    /Controller ready/,
  );
  await e
    .locator("#scaling-panel")
    .screenshot({ path: "test-results/scaling-panel-dark-test-fixture.png" });
  await e.getByRole("button", { name: "Light theme", exact: true }).click();
  await e
    .locator("#scaling-panel")
    .screenshot({ path: "test-results/scaling-panel-light-test-fixture.png" });
  clusterEnvironment = true;
  await e.locator("#cluster-note").waitFor({ state: "visible" });
  assert.match(await e.locator("#cluster-note").textContent(), /throttl/);
  assert.match(await e.locator("#cluster-note").textContent(), /one pod/);
  assert.deepEqual(await e.locator("#cluster-note mark").allTextContents(), [
    "CPU limits can throttle",
    "use one pod",
  ]);
  await e
    .locator("#scale-out-command")
    .evaluate((n) => (n.closest("details").open = false));
  await e.evaluate(() => scrollTo(0, 0));
  await e.screenshot({ path: "test-results/openshift-test-fixture.png" });
  await e.reload();
  await e.getByText("Connected · live", { exact: true }).waitFor();
  assert.equal(
    await e.locator("#openshift-console").inputValue(),
    "https://console.example/topology/ns/test",
  );
  console.log(
    "Positive two-runtime fixture checks passed: baseline preservation, prime workload, insights, automatic evidence, OS RSS, build costs, snapshot phase selection",
  );
} finally {
  await evidenceContext.close();
  await browser.close();
}
