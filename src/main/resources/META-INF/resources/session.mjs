export const KEY = "runtime-lab.session.v1";
export const numeric = (x) =>
  typeof x === "number" && Number.isFinite(x) && x >= 0;
export const positive = (x) => numeric(x) && x > 0;
export function fresh() {
  return {
    version: 1,
    name: "Untitled comparison",
    revision: "",
    theme: "dark",
    phase: 0,
    runs: [],
    observations: [],
  };
}
export function decode(text) {
  const s = JSON.parse(text);
  if (
    s?.version !== 1 ||
    !Array.isArray(s.runs) ||
    !Array.isArray(s.observations) ||
    typeof s.name !== "string" ||
    typeof s.revision !== "string" ||
    !["light", "dark"].includes(s.theme) ||
    !Number.isInteger(s.phase) ||
    s.phase < 0 ||
    s.phase > 4
  )
    throw Error("Invalid or unsupported session");
  for (const r of s.runs) {
    if (
      typeof r.id !== "string" ||
      !["jvm", "native-image"].includes(r.runtime) ||
      !Array.isArray(r.samples) ||
      !Array.isArray(r.batches) ||
      !Array.isArray(r.snapshots) ||
      !r.settings ||
      typeof r.settings !== "object"
    )
      throw Error("Invalid process run");
    for (const x of r.samples)
      if (
        !["first", "repeat"].includes(x.kind) ||
        x.input !== 40 ||
        !positive(x.serverNs) ||
        !positive(x.httpMs) ||
        !numeric(x.result) ||
        x.processId !== r.id
      )
        throw Error("Invalid sample");
  }
  return s;
}
export function save(storage, s) {
  storage.setItem(KEY, JSON.stringify(s));
}
export function load(storage) {
  const text = storage.getItem(KEY);
  return text ? decode(text) : fresh();
}
export function observe(s, info) {
  if (
    !["jvm", "native-image"].includes(info.runtime_type) ||
    typeof info.process_id !== "string" ||
    !info.process_id
  )
    throw Error("Runtime identity unavailable; benchmark disabled");
  let run = s.runs.find((r) => r.id === info.process_id);
  if (run && run.runtime !== info.runtime_type)
    throw Error("Conflicting process identity");
  if (!run) {
    run = {
      id: info.process_id,
      runtime: info.runtime_type,
      createdAt: new Date().toISOString(),
      revision: s.revision,
      settings: {},
      samples: [],
      batches: [],
      snapshots: [],
      costs: {},
    };
    s.runs.push(run);
  }
  return run;
}
export function stats(samples, field = "serverNs") {
  const values = samples
      .filter((x) => x.kind === "repeat")
      .map((x) => x[field])
      .filter(positive)
      .sort((a, b) => a - b),
    n = values.length;
  return {
    count: n,
    median: n
      ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2
      : null,
    min: n ? values[0] : null,
    max: n ? values[n - 1] : null,
  };
}
export function compare(a, b, kind = "repeat", field = "serverNs") {
  const fail = (reason) => ({ ratio: null, reason });
  if (!a || !b) return fail("Collect both runtime runs");
  if (a.runtime !== "jvm" || b.runtime !== "native-image")
    return fail("Select JVM and Native Image");
  const left = a.samples.filter((x) => x.kind === kind),
    right = b.samples.filter((x) => x.kind === kind);
  if (!left.length || !right.length) return fail("Samples not collected");
  if (
    ![...left, ...right].every(
      (x) => x.input === 40 && x.result === left[0].result,
    )
  )
    return fail("Input or result mismatch");
  const av = kind === "first" ? left[0][field] : stats(left, field).median,
    bv = kind === "first" ? right[0][field] : stats(right, field).median;
  if (!positive(av) || !positive(bv))
    return fail("Positive matching measurements unavailable");
  return { ratio: av / bv, reason: "JVM ÷ Native Image", a: av, b: bv };
}
export function settingsWarnings(a, b) {
  return ["revision", "cpu", "heap", "memory", "flags", "environment"].flatMap(
    (k) => {
      const av = k === "revision" ? a?.revision : a?.settings?.[k],
        bv = k === "revision" ? b?.revision : b?.settings?.[k];
      return !av || !bv
        ? [`${k}: unknown`]
        : av !== bv
          ? [`${k}: differs (${av} / ${bv})`]
          : [];
    },
  );
}
// Stops at the first error. Successful calls survive a partial batch; failures never become zeroes.
export async function batch(run, count, request, onSample = () => {}) {
  const kind = run.samples.some((x) => x.kind === "first") ? "repeat" : "first";
  const report = {
    at: new Date().toISOString(),
    requested: count,
    completed: 0,
    error: null,
    kind,
  };
  run.batches.push(report);
  for (let i = 0; i < count; i++) {
    try {
      const x = await request();
      if (x.data.process_id !== run.id)
        throw Error("Process changed during batch; response excluded");
      if (
        x.data.input_n !== 40 ||
        !numeric(x.data.result) ||
        !positive(x.data.duration_ns) ||
        !positive(x.httpMs)
      )
        throw Error("Invalid benchmark response");
      const sample = {
        kind: kind === "first" && i === 0 ? "first" : "repeat",
        input: 40,
        result: x.data.result,
        serverNs: x.data.duration_ns,
        httpMs: x.httpMs,
        processId: run.id,
        at: new Date().toISOString(),
        raw: x.data,
      };
      if (run.samples.length && run.samples[0].result !== sample.result)
        throw Error("Result mismatch; response excluded");
      run.samples.push(sample);
      report.completed++;
      onSample();
    } catch (e) {
      report.error = e.message;
      break;
    }
  }
  return report;
}
