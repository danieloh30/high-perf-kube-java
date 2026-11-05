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
