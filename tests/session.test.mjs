import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fresh,
  save,
  load,
  decode,
  observe,
  batch,
  stats,
  compare,
  settingsWarnings,
  numeric,
} from "../src/main/resources/META-INF/resources/session.mjs";
const info = (id, runtime_type = "jvm") => ({ process_id: id, runtime_type });
const response = (id, result = 102334155, ns = 100) => ({
  data: { process_id: id, input_n: 40, result, duration_ns: ns },
  httpMs: 2,
});
test("complete session survives storage and export/import including theme, snapshots and costs", async () => {
  const s = fresh(),
    r = observe(s, info("a"));
  s.theme = "light";
  r.settings.cpu = "2";
  r.snapshots.push({ label: "baseline" });
  r.costs = { artifact_bytes: 123 };
  await batch(r, 1, async () => response("a"));
  const storage = {
    setItem(k, v) {
      this[k] = v;
    },
    getItem(k) {
      return this[k];
    },
  };
  save(storage, s);
  assert.deepEqual(load(storage), s);
  assert.deepEqual(decode(JSON.stringify(s)), s);
});
test("process switch and same-runtime restart isolate samples", async () => {
  const s = fresh(),
    a = observe(s, info("a"));
  await batch(a, 1, async () => response("a"));
  const b = observe(s, info("b", "native-image"));
  const c = observe(s, info("c"));
  assert.equal(s.runs.length, 3);
  assert.equal(b.samples.length, 0);
  assert.equal(c.samples.length, 0);
  assert.equal(observe(s, info("a")), a);
  assert.equal(a.samples.length, 1);
});
test("partial failures retain successes, never add zeroes, and can resume", async () => {
  const r = observe(fresh(), info("a"));
  await batch(r, 1, async () => response("a"));
  let n = 0;
  const report = await batch(r, 5, async () => {
    if (++n === 3) throw Error("offline");
    return response("a", 102334155, n * 100);
  });
  assert.equal(report.completed, 2);
  assert.equal(report.error, "offline");
  assert.deepEqual(stats(r.samples), {
    count: 2,
    median: 150,
    min: 100,
    max: 200,
  });
  assert.equal(r.samples[0].kind, "first");
  await batch(r, 5, async () => response("a"));
  assert.equal(stats(r.samples).count, 7);
});
test("changed process and invalid timings excluded", async () => {
  for (const x of [
    response("b"),
    response("a", 102334155, 0),
    response("a", 102334155, null),
  ]) {
    const r = observe(fresh(), info("a"));
    const report = await batch(r, 1, async () => x);
    assert.equal(report.completed, 0);
    assert.ok(report.error);
    assert.equal(r.samples.length, 0);
  }
});
test("comparisons match inputs, outputs and positive boundaries; first stays separate", async () => {
  const s = fresh(),
    a = observe(s, info("a")),
    b = observe(s, info("b", "native-image"));
  assert.equal(compare(a, b).ratio, null);
  await batch(a, 1, async () => response("a", 42, 200));
  await batch(b, 1, async () => response("b", 42, 100));
  assert.equal(compare(a, b, "first").ratio, 2);
  assert.equal(compare(a, b).ratio, null);
  await batch(a, 5, async () => response("a", 42, 400));
  await batch(b, 5, async () => response("b", 42, 100));
  assert.equal(compare(a, b).ratio, 4);
  assert.equal(compare(a, b, "repeat", "httpMs").ratio, 1);
  b.samples[1].input = 41;
  assert.equal(compare(a, b).ratio, null);
  b.samples[1].input = 40;
  b.samples[1].result = 43;
  assert.equal(compare(a, b).ratio, null);
});
test("unknown and mismatched resources are explicit; unavailable is never zero", () => {
  assert.equal(numeric(null), false);
  assert.equal(numeric(-1), false);
  assert.equal(numeric(""), false);
  assert.equal(stats([]).median, null);
  const a = { settings: { cpu: "2" } },
    b = { settings: { cpu: "4" } };
  assert.ok(settingsWarnings(a, b).some((x) => x.includes("differs")));
  assert.ok(settingsWarnings(a, b).some((x) => x.includes("unknown")));
});
test("invalid imports are rejected without coercion", () => {
  assert.throws(() => decode('{"version":2}'));
  const s = fresh();
  s.runs = [{}];
  assert.throws(() => decode(JSON.stringify(s)));
  s.runs = [];
  s.phase = 90;
  assert.throws(() => decode(JSON.stringify(s)));
});

test("pre-load is preserved, post-load stays separate, and missed baselines cannot be invented", async () => {
  const { snapshot, baseline, postload } =
    await import("../src/main/resources/META-INF/resources/session.mjs");
  const r = observe(fresh(), info("a"));
  const before = snapshot(
    r,
    { ...info("a"), heap_used_mb: 10 },
    null,
    "pre-load",
  );
  await batch(r, 1, async () => response("a"));
  snapshot(r, { ...info("a"), heap_used_mb: 20 }, null, "post-load");
  assert.equal(baseline(r), before);
  assert.equal(baseline(r).info.heap_used_mb, 10);
  assert.equal(postload(r).info.heap_used_mb, 20);
  const missing = observe(fresh(), info("b"));
  await batch(missing, 1, async () => response("b"));
  assert.throws(() => snapshot(missing, info("b"), null, "pre-load"), /missed/);
});
test("v1 sessions migrate without pretending legacy snapshots are pre-load", async () => {
  const { baseline } =
    await import("../src/main/resources/META-INF/resources/session.mjs");
  const s = fresh(),
    r = observe(s, info("a"));
  s.version = 1;
  r.snapshots.push({
    label: "Presenter baseline snapshot",
    info: { heap_used_mb: 10 },
  });
  const restored = decode(JSON.stringify(s));
  assert.equal(restored.version, 2);
  assert.equal(restored.runs[0].snapshots[0].kind, "legacy");
  assert.equal(baseline(restored.runs[0]), undefined);
});
test("process-matched evidence attaches costs and settings; foreign evidence excluded", () => {
  const s = fresh(),
    evidence = {
      status: "collected",
      data: {
        process_id: "a",
        runtime: "jvm",
        revision: "abc",
        costs: { build_seconds: 12 },
        settings: { cpu: "2" },
        launch: { duration_ms: 456 },
      },
    };
  const r = observe(s, { ...info("a"), demo_evidence: evidence });
  assert.equal(r.costs.build_seconds, 12);
  assert.equal(r.settings.cpu, "2");
  assert.equal(r.evidence.launch.duration_ms, 456);
  const b = observe(s, { ...info("b"), demo_evidence: evidence });
  assert.equal(b.evidence, undefined);
  assert.deepEqual(b.costs, {});
});
test("prime results and summaries remain separate from Fibonacci and validate both outputs", async () => {
  const { samplesFor, insight } =
    await import("../src/main/resources/META-INF/resources/session.mjs");
  const s = fresh(),
    a = observe(s, info("a")),
    b = observe(s, info("b", "native-image"));
  const prime = (id, ns) => ({
    data: {
      process_id: id,
      limit: 1000000,
      prime_count: 78498,
      largest_prime: 999983,
      duration_ns: ns,
    },
    httpMs: 3,
  });
  await batch(a, 1, async () => response("a"));
  await batch(
    a,
    1,
    async () => prime("a", 200),
    () => {},
    "primes",
  );
  await batch(
    a,
    5,
    async () => prime("a", 200),
    () => {},
    "primes",
  );
  await batch(
    b,
    1,
    async () => prime("b", 100),
    () => {},
    "primes",
  );
  await batch(
    b,
    5,
    async () => prime("b", 100),
    () => {},
    "primes",
  );
  assert.equal(samplesFor(a).length, 1);
  assert.equal(stats(samplesFor(a, "primes")).count, 5);
  assert.equal(compare(a, b, "repeat", "serverNs", "primes").ratio, 2);
  assert.match(insight(a, b, "primes"), /50.0% less/);
  b.samples[1].largestPrime = 123;
  assert.equal(compare(a, b, "repeat", "serverNs", "primes").ratio, null);
});

test("insights also report JVM wins and equality without promising a universal winner", async () => {
  const { insight } =
    await import("../src/main/resources/META-INF/resources/session.mjs");
  const s = fresh(),
    a = observe(s, info("a")),
    b = observe(s, info("b", "native-image"));
  await batch(a, 1, async () => response("a", 42, 100));
  await batch(a, 5, async () => response("a", 42, 100));
  await batch(b, 1, async () => response("b", 42, 200));
  await batch(b, 5, async () => response("b", 42, 200));
  assert.match(insight(a, b), /JVM took 50.0% less/);
  for (const x of b.samples) x.serverNs = 100;
  assert.match(insight(a, b), /equal/);
  assert.equal(compare(a, b, "repeat", "unknown").ratio, null);
});
