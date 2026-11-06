import { deploymentDefaults } from "./deployment.mjs?v=20261106-4";
export const KEY = "runtime-lab.session.v2";
export const LEGACY_KEY = "runtime-lab.session.v1";
export const numeric = (x) =>
  typeof x === "number" && Number.isFinite(x) && x >= 0;
export const positive = (x) => numeric(x) && x > 0;
export const BENCHMARKS = {
  fib: {
    name: "Fibonacci / 40",
    input: 40,
    url: "/perf/fib?n=40",
    description:
      "Recursive integer computation. Shows this algorithm, not startup or a general runtime ranking.",
  },
  primes: {
    name: "Prime sieve / 1,000,000",
    input: 1000000,
    url: "/perf/primes?limit=1000000",
    description:
      "Array allocation, marking and list construction. A different CPU/allocation workload; not a memory-usage measurement.",
  },
};
export function fresh() {
  return {
    version: 2,
    presentationVersion: 2,
    deployment: deploymentDefaults(),
    name: "Untitled comparison",
    revision: "",
    theme: "dark",
    phase: 0,
    benchmark: "fib",
    runs: [],
    observations: [],
  };
}
export function decode(text) {
  const s = JSON.parse(text);
  if (
    ![1, 2].includes(s?.version) ||
    !Array.isArray(s.runs) ||
    !Array.isArray(s.observations) ||
    typeof s.name !== "string" ||
    typeof s.revision !== "string" ||
    !["light", "dark"].includes(s.theme) ||
    !Number.isInteger(s.phase) ||
    s.phase < 0 ||
    s.phase > 5
  )
    throw Error("Invalid or unsupported session");
  const legacy = s.version === 1;
  if (!s.presentationVersion && s.phase === 4) s.phase = 5;
  s.presentationVersion = 2;
  s.deployment = {
    ...deploymentDefaults(),
    ...(s.deployment && typeof s.deployment === "object" ? s.deployment : {}),
  };
  s.benchmark = s.benchmark || "fib";
  if (!BENCHMARKS[s.benchmark]) throw Error("Invalid benchmark");
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
    for (const x of r.samples) {
      x.benchmark = x.benchmark || "fib";
      if (
        !BENCHMARKS[x.benchmark] ||
        !["first", "repeat"].includes(x.kind) ||
        x.input !== BENCHMARKS[x.benchmark].input ||
        !positive(x.serverNs) ||
        !positive(x.httpMs) ||
        !numeric(x.result) ||
        x.processId !== r.id ||
        (x.benchmark === "primes" && !numeric(x.largestPrime))
      )
        throw Error("Invalid sample");
    }
    if (legacy) for (const x of r.snapshots) x.kind = "legacy";
  }
  s.version = 2;
  return s;
}
export function save(storage, s) {
  storage.setItem(KEY, JSON.stringify(s));
}
export function load(storage) {
  const text = storage.getItem(KEY) || storage.getItem(LEGACY_KEY);
  return text ? decode(text) : fresh();
}
export function reconcileReset(session, info, keepImported = false) {
  const data =
    info?.demo_evidence?.status === "collected"
      ? info.demo_evidence.data
      : null;
  const generation = data?.reset_generation;
  if (
    data?.process_id !== info?.process_id ||
    data?.runtime !== (info?.runtime_type === "jvm" ? "jvm" : "native") ||
    typeof generation !== "string" ||
    !generation
  )
    return { session, cleared: false };
  if (
    keepImported ||
    session.backendGeneration === generation ||
    (!session.backendGeneration &&
      (generation === "initial" || session.runs.length === 0))
  ) {
    session.backendGeneration = generation;
    return { session, cleared: false };
  }
  const next = fresh();
  next.theme = session.theme;
  next.backendGeneration = generation;
  return { session: next, cleared: true };
}
export function samplesFor(run, benchmark = "fib") {
  return (run?.samples || []).filter(
    (x) => (x.benchmark || "fib") === benchmark,
  );
}
export function attachEvidence(run, info) {
  const evidence = info?.demo_evidence;
  if (evidence?.status !== "collected") return false;
  const data = evidence.data;
  if (
    data?.process_id !== run.id ||
    data.runtime !== (run.runtime === "jvm" ? "jvm" : "native")
  )
    return false;
  if (!run.evidence) {
    run.evidence = structuredClone(data);
    run.revision = run.revision || data.revision || "";
    run.settings = { ...data.settings, ...run.settings };
    run.costs = { ...data.costs, ...run.costs };
  }
  return true;
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
  attachEvidence(run, info);
  return run;
}
export function baseline(run) {
  return run?.snapshots.find((x) => x.kind === "pre-load");
}
export function postload(run) {
  return run?.snapshots.filter((x) => x.kind === "post-load").at(-1);
}
export function snapshot(run, info, readiness, kind) {
  if (!run || !info || info.process_id !== run.id)
    throw Error("Current process observation required");
  if (kind === "pre-load") {
    if (baseline(run)) return baseline(run);
    if (run.samples.length)
      throw Error(
        "Pre-load baseline was missed. Restart this runtime for a fresh pre-load observation.",
      );
  } else if (kind !== "post-load") throw Error("Invalid snapshot phase");
  const value = {
    kind,
    label: kind === "pre-load" ? "Pre-load baseline" : "Post-load snapshot",
    at: new Date().toISOString(),
    info: structuredClone(info),
    readiness: structuredClone(readiness),
  };
  run.snapshots.push(value);
  return value;
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
export function compare(
  a,
  b,
  kind = "repeat",
  field = "serverNs",
  benchmark = "fib",
) {
  const fail = (reason) => ({ ratio: null, reason });
  if (!a || !b) return fail("Collect both runtime runs");
  if (a.runtime !== "jvm" || b.runtime !== "native-image")
    return fail("Select JVM and Native Image");
  const left = samplesFor(a, benchmark).filter((x) => x.kind === kind),
    right = samplesFor(b, benchmark).filter((x) => x.kind === kind);
  if (!left.length || !right.length) return fail("Samples not collected");
  if (
    ![...left, ...right].every(
      (x) =>
        x.input === BENCHMARKS[benchmark].input &&
        x.result === left[0].result &&
        (benchmark !== "primes" || x.largestPrime === left[0].largestPrime),
    )
  )
    return fail("Input or result mismatch");
  if (!["serverNs", "httpMs"].includes(field))
    return fail("Unknown measurement boundary");
  const av = kind === "first" ? left[0][field] : stats(left, field).median,
    bv = kind === "first" ? right[0][field] : stats(right, field).median;
  if (!positive(av) || !positive(bv))
    return fail("Positive matching measurements unavailable");
  return { ratio: av / bv, reason: "JVM ÷ Native Image", a: av, b: bv };
}
export function insight(a, b, benchmark = "fib") {
  const c = compare(a, b, "repeat", "serverNs", benchmark),
    left = samplesFor(a, benchmark),
    right = samplesFor(b, benchmark);
  if (!c.ratio)
    return `Repeated computation comparison unavailable: ${c.reason}.`;
  if (c.a === c.b)
    return "The repeated server computation medians are equal at the recorded precision. This does not establish equivalent performance for other workloads.";
  const runtime = c.a >= c.b ? "Native Image" : "JVM",
    percent =
      (100 * (Math.max(c.a, c.b) - Math.min(c.a, c.b))) / Math.max(c.a, c.b);
  return `${runtime} took ${percent.toFixed(1)}% less server computation time by repeated median (${stats(left).count} JVM / ${stats(right).count} native samples). Results and inputs match. Few calls; not a steady-state or SLO test.`;
}
export function settingsWarnings(a, b) {
  const warnings = [
    "revision",
    "cpu",
    "heap",
    "memory",
    "flags",
    "environment",
  ].flatMap((k) => {
    const av = k === "revision" ? a?.revision : a?.settings?.[k],
      bv = k === "revision" ? b?.revision : b?.settings?.[k];
    return !av || !bv
      ? [`${k}: unknown`]
      : av !== bv
        ? [`${k}: differs (${av} / ${bv})`]
        : [];
  });
  if (a?.evidence?.dirty || b?.evidence?.dirty)
    warnings.push(
      "Build used a dirty checkout; commit revision alone does not identify its contents",
    );
  if (
    a?.evidence?.source_hash &&
    b?.evidence?.source_hash &&
    a.evidence.source_hash !== b.evidence.source_hash
  )
    warnings.push("Application source hashes differ");
  return warnings;
}
export async function batch(
  run,
  count,
  request,
  onSample = () => {},
  benchmark = "fib",
) {
  const existing = samplesFor(run, benchmark),
    kind = existing.some((x) => x.kind === "first") ? "repeat" : "first";
  const report = {
    at: new Date().toISOString(),
    requested: count,
    completed: 0,
    error: null,
    kind,
    benchmark,
  };
  run.batches.push(report);
  for (let i = 0; i < count; i++) {
    try {
      const x = await request(),
        data = x.data;
      if (data.process_id !== run.id)
        throw Error("Process changed during batch; response excluded");
      const input = benchmark === "fib" ? data.input_n : data.limit,
        result = benchmark === "fib" ? data.result : data.prime_count;
      if (
        input !== BENCHMARKS[benchmark].input ||
        !numeric(result) ||
        !positive(data.duration_ns) ||
        !positive(x.httpMs) ||
        (benchmark === "primes" && !numeric(data.largest_prime))
      )
        throw Error("Invalid benchmark response");
      const sample = {
        kind: kind === "first" && i === 0 ? "first" : "repeat",
        benchmark,
        input,
        result,
        serverNs: data.duration_ns,
        httpMs: x.httpMs,
        processId: run.id,
        at: new Date().toISOString(),
        raw: data,
      };
      if (benchmark === "primes") sample.largestPrime = data.largest_prime;
      if (
        existing.length &&
        (existing[0].result !== sample.result ||
          (benchmark === "primes" &&
            existing[0].largestPrime !== sample.largestPrime))
      )
        throw Error("Result mismatch; response excluded");
      existing.push(sample);
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
