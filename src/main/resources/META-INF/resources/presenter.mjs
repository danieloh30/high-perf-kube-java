import {
  deploymentDefaults,
  deploymentCommands,
  consoleLink,
  deployReference,
  matchingReceipt,
  scaleCommands,
} from "./deployment.mjs?v=20261106-4";
import {
  fresh,
  reconcileReset,
  KEY,
  LEGACY_KEY,
  BENCHMARKS,
  samplesFor,
  baseline,
  postload,
  snapshot as recordSnapshot,
  insight,
  workloadInsight,
  load,
  save,
  decode,
  observe,
  stats,
  compare,
  settingsWarnings,
  numeric,
  batch,
} from "./session.mjs?v=20261106-4";
const $ = (id) => document.getElementById(id);
let session;
try {
  session = load(localStorage);
} catch (e) {
  session = fresh();
  $("notice").textContent =
    `Stored session could not be loaded: ${e.message}. Export any recoverable browser data before saving.`;
}
let active = null,
  info = null,
  health = null,
  connected = false,
  busy = false,
  polling = null,
  timer = null,
  backoff = 1000,
  preserveImportedOnNextPoll = false,
  clusterControl = null,
  selected = { jvm: null, "native-image": null };
const phases = [
  [
    "Start",
    "Know the running process.",
    "Observe runtime identity and memory, then save a labeled baseline.",
    "Save pre-load baseline",
  ],
  [
    "Load",
    "Make the work visible.",
    "Collect the first sample, then five deliberate sequential measurements.",
    "Save post-load and switch runtime",
  ],
  [
    "Switch runtime",
    "One port. Two runtimes.",
    "Switch prepared artifacts in the terminal. Your session stays here.",
    "Go to Start",
  ],
  [
    "Compare",
    "Compare the same work.",
    "First samples and repeated medians, with explicit measurement boundaries.",
    "Continue to Containerize",
  ],
  [
    "Containerize",
    "Package once. Run anywhere compatible.",
    "Inspect the prepared Quarkus + Jib image and reuse it locally or in your cluster.",
    "Continue to Kubernetes",
  ],
  [
    "Kubernetes",
    "Take the image to your cluster.",
    "Copy the image reference and open your prepared OpenShift console.",
    "Export session",
  ],
];
function persist() {
  try {
    save(localStorage, session);
    $("storage-status").textContent = "Saved locally · schema v2";
  } catch (e) {
    $("storage-status").textContent =
      `Persistence failed: ${e.message}. Export this session now.`;
  }
  renderRaw();
}
function tell(text) {
  $("notice").textContent = text;
}
function fmt(n, unit = "") {
  return numeric(n)
    ? `${n.toLocaleString(undefined, { maximumFractionDigits: 3 })}${unit}`
    : "Unavailable";
}
function ms(ns) {
  return numeric(ns) ? fmt(ns / 1e6, " ms") : "Not collected";
}
function el(tag, text, cls) {
  const x = document.createElement(tag);
  x.textContent = text;
  if (cls) x.className = cls;
  return x;
}
function selectedRun(runtime) {
  return (
    session.runs.find((r) => r.id === selected[runtime]) ||
    session.runs.filter((r) => r.runtime === runtime).at(-1)
  );
}
function renderRaw() {
  $("raw").textContent = JSON.stringify(session, null, 2);
  $("session-caption").textContent =
    `${session.name} / ${session.runs.length} process runs / saved session`;
}
function render() {
  document.documentElement.dataset.theme = session.theme;
  document.body.dataset.phase = session.phase;
  $("theme").textContent =
    session.theme === "dark" ? "Light theme" : "Dark theme";
  if (!$("phases").children.length)
    $("phases").replaceChildren(
      ...phases.map((p, i) => {
        const b = el(
          "button",
          `${String(i + 1).padStart(2, "0")}  ${p[0]}`,
          session.phase === i ? "active" : "",
        );
        b.onclick = () => {
          session.phase = i;
          persist();
          render();
        };
        return b;
      }),
    );
  [...$("phases").children].forEach((b, i) =>
    b.classList.toggle("active", session.phase === i),
  );
  const p = phases[session.phase];
  $("phase-label").textContent =
    `${String(session.phase + 1).padStart(2, "0")} / ${p[0].toUpperCase()}`;
  $("title").textContent = p[1];
  $("subtitle").textContent = p[2];
  $("primary").textContent =
    session.phase === 1 &&
    session.runs.some((r) => r.runtime !== active?.runtime && r.samples.length)
      ? "Save post-load and compare"
      : p[3];
  if (session.phase === 0 && active?.samples.length && !baseline(active))
    $("primary").textContent = "Continue (pre-load baseline missed)";
  $("load-benchmark").value = session.benchmark;
  $("compare-benchmark").value = session.benchmark;
  $("load-benchmark").disabled = busy;
  $("workload-description").textContent =
    BENCHMARKS[session.benchmark].description;
  $("primary").disabled = busy || (session.phase < 2 && !connected);
  ["start", "load", "switch", "compare", "containerize", "kubernetes"].forEach(
    (id, i) => ($(id).hidden = session.phase !== i),
  );
  $("connection").textContent = busy
    ? "Benchmarking · polling paused"
    : connected
      ? "Connected · live"
      : "Disconnected / reconnecting";
  $("cluster-note").hidden = info?.execution_environment?.mode !== "kubernetes";
  $("runtime").textContent =
    connected && active
      ? active.runtime === "jvm"
        ? "JVM"
        : "Native Image"
      : "Runtime unavailable";
  $("runtime").className =
    `pill ${connected && active ? (active.runtime === "jvm" ? "jvm" : "native") : ""}`;
  const check = health?.checks?.find((x) => x.name === "app-readiness");
  const metrics = [
    [
      "Runtime identity",
      connected ? info?.vm_name : null,
      connected ? info?.java_version : "No current observation",
    ],
    [
      "Available processors",
      connected ? info?.available_processors : null,
      "Runtime-reported logical processors",
    ],
    [
      "Process uptime",
      connected ? fmt(info?.uptime_ms, " ms") : null,
      "Not startup duration",
    ],
    [
      "Heap used",
      connected ? fmt(info?.heap_used_mb, " MiB") : null,
      `Max ${connected ? fmt(info?.heap_max_mb, " MiB") : "Unavailable"} · committed ${connected ? fmt(info?.heap_committed_mb, " MiB") : "Unavailable"}`,
    ],
    [
      "Non-heap used",
      connected ? fmt(info?.non_heap_used_mb, " MiB") : null,
      "Separate from heap, RSS and container memory",
    ],
    [
      "Readiness",
      connected ? health?.status : null,
      `Uptime at StartupEvent: ${connected ? fmt(check?.data?.startup_time_ms, " ms") : "Unavailable"}`,
    ],
  ];
  $("metrics").replaceChildren(
    ...metrics.map(([label, value, note]) => {
      const c = el("article", "", "metric");
      c.append(
        el("label", label),
        el("span", value ?? "Unavailable", "value"),
        el("small", note ?? "Unavailable"),
      );
      return c;
    }),
  );
  const workloadSamples = samplesFor(active, session.benchmark);
  const first = workloadSamples.find((x) => x.kind === "first"),
    s = stats(workloadSamples);
  $("load-results").replaceChildren(
    el("div", "CURRENT PROCESS / SAVED MEASUREMENTS", "eyebrow"),
    el("h2", first ? ms(first.serverNs) : "First sample not collected"),
    el("p", "First sample in this session · server computation"),
    el("div", `Repeated median: ${ms(s.median)}`, "big"),
    el(
      "p",
      `${s.count} successful repeated samples · min ${ms(s.min)} · max ${ms(s.max)}`,
    ),
    el(
      "p",
      first
        ? `First browser HTTP: ${fmt(first.httpMs, " ms")} · result ${first.result}`
        : "Browser HTTP: not collected",
    ),
  );
  const hasFirst = !!first;
  $("first").disabled = busy || !connected || hasFirst;
  $("more").disabled = busy || !connected || !hasFirst;
  $("switch-state").textContent = connected
    ? `Connected to ${active?.runtime}, process ${active?.id}. Use Load to collect this process.`
    : "Backend unavailable. Reconnecting with bounded requests and exponential backoff (up to 15 s).";
  renderSelectors();
  renderComparison();
  renderObservations();
  renderDeployment();
  renderRaw();
}
function renderSelectors() {
  for (const [id, runtime] of [
    ["jvm-run", "jvm"],
    ["native-run", "native-image"],
  ]) {
    const select = $(id),
      runs = session.runs.filter((r) => r.runtime === runtime),
      signature = runs.map((r) => r.id).join("|");
    if (select.dataset.signature === signature) {
      select.value = selectedRun(runtime)?.id || "";
      continue;
    }
    select.dataset.signature = signature;
    select.replaceChildren();
    if (!runs.length) select.append(new Option("Not run in this session", ""));
    for (const r of runs)
      select.append(
        new Option(`${r.id.slice(0, 8)} · ${r.createdAt} · saved`, r.id),
      );
    select.value = selectedRun(runtime)?.id || "";
    select.onchange = () => {
      selected[runtime] = select.value;
      renderComparison();
    };
  }
  const select = $("settings-run"),
    old = select.value,
    signature = session.runs.map((r) => r.id).join("|");
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.replaceChildren(
      ...session.runs.map(
        (r) => new Option(`${r.runtime} · ${r.id.slice(0, 8)}`, r.id),
      ),
    );
    select.value = active?.id || old || session.runs.at(-1)?.id || "";
  }
  const signatureFields = select.value + ":" + !!editingRun()?.evidence;
  if (select.dataset.loaded !== signatureFields) {
    select.dataset.loaded = signatureFields;
    fillRunFields();
  }
}
function highlightInsight(text) {
  const target = $("computation-insight");
  target.replaceChildren();
  const pattern =
    /Native Image|JVM|[0-9]+(?:\.[0-9]+)?%|server computation time|Results and inputs match|steady state|unavailable/g;
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    target.append(document.createTextNode(text.slice(end, match.index)));
    const token = el(
      "mark",
      match[0],
      match[0] === "JVM"
        ? "jvm"
        : match[0] === "Native Image"
          ? "native"
          : match[0].endsWith("%")
            ? "insight-number"
            : "",
    );
    target.append(token);
    end = match.index + match[0].length;
  }
  target.append(document.createTextNode(text.slice(end)));
}
let comparisonSignature = "";
function renderComparison() {
  const benchmark = session.benchmark;
  const a = selectedRun("jvm"),
    b = selectedRun("native-image"),
    grid = el("div", "", "compare-grid");
  const signature = JSON.stringify([a, b, benchmark, session.observationPhase]);
  if (signature === comparisonSignature) return;
  // Background polls must not replace a focused native select or reset its popup.
  comparisonSignature = signature;
  highlightInsight(insight(a, b, benchmark));
  $("insight-workload").textContent = workloadInsight(a, b, benchmark);
  grid.append(
    el("div", "MEASUREMENT"),
    el("div", a ? "JVM" : "JVM · NOT RUN", "jvm big"),
    el("div", b ? "NATIVE IMAGE" : "NATIVE IMAGE · NOT RUN", "native big"),
  );
  for (const [kind, field, label] of [
    ["first", "serverNs", "First / server computation"],
    ["repeat", "serverNs", "Repeated median / server computation"],
    ["first", "httpMs", "First / browser HTTP"],
    ["repeat", "httpMs", "Repeated median / browser HTTP"],
  ]) {
    const c = compare(a, b, kind, field, benchmark),
      format =
        field === "serverNs"
          ? ms
          : (x) => (numeric(x) ? fmt(x, " ms") : "Not collected");
    const value = (r) =>
      kind === "first"
        ? samplesFor(r, benchmark).find((x) => x.kind === "first")?.[field]
        : stats(samplesFor(r, benchmark), field).median;
    const heading = el("div", label);
    heading.append(
      el("p", c.ratio ? `${c.ratio.toFixed(2)}× JVM ÷ Native Image` : c.reason),
    );
    grid.append(
      heading,
      el("div", format(value(a)), "jvm big"),
      el("div", format(value(b)), "native big"),
    );
  }
  const wasOpen = $("comparison").querySelector("details")?.open;
  const extra = el("details", ""),
    extraGrid = el("div", "", "compare-grid");
  extra.open = !!wasOpen;
  extraGrid.append(
    el("div", "SAVED OBSERVATIONS"),
    el("div", "JVM", "jvm"),
    el("div", "NATIVE IMAGE", "native"),
  );
  extra.append(
    el("summary", "Baseline memory & recorded build costs"),
    extraGrid,
  );
  const observationLabel = el("label", "Memory snapshot phase"),
    observationSelect = document.createElement("select");
  observationSelect.id = "observation-phase";
  for (const [value, label] of [
    ["pre-load", "Pre-load baseline"],
    ["post-load", "Post-load snapshot"],
  ])
    observationSelect.append(new Option(label, value));
  observationSelect.value = session.observationPhase || "pre-load";
  observationSelect.onchange = () => {
    session.observationPhase = observationSelect.value;
    persist();
    renderComparison();
  };
  observationLabel.append(observationSelect);
  extra.insertBefore(observationLabel, extraGrid);
  const saved = (r) =>
    (session.observationPhase || "pre-load") === "pre-load"
      ? baseline(r)
      : postload(r);
  const missing =
    "Snapshot not saved for this phase; return to Start before Load for a pre-load baseline.";
  for (const [key, label] of [
    ["heap_used_mb", "Heap used / MiB"],
    ["non_heap_used_mb", "Non-heap used / MiB"],
  ]) {
    extraGrid.append(
      el("div", label),
      ...[a, b].map((r) => {
        const snapshot = saved(r),
          d = el(
            "div",
            snapshot ? fmt(snapshot.info?.[key]) : "Snapshot not saved",
          );
        d.append(
          el("p", snapshot ? `${snapshot.label} · ${snapshot.at}` : missing),
        );
        return d;
      }),
    );
  }
  for (const [key, label] of [
    ["process_rss", "Process RSS / MiB"],
    ["container_memory", "Container cgroup usage / MiB"],
  ]) {
    extraGrid.append(
      el("div", label),
      ...[a, b].map((r) => {
        const snapshot = saved(r),
          measurement = snapshot?.info?.[key];
        const hostContainer =
          key === "container_memory" &&
          measurement?.status === "not-applicable";
        const value = hostContainer
          ? "Not applicable · host process"
          : !snapshot
            ? "Snapshot not saved"
            : measurement?.status === "collected"
              ? fmt(measurement.value_mib)
              : measurement?.status === "not-applicable"
                ? "Not applicable"
                : "Not collected";
        const d = el("div", value);
        d.append(
          el(
            "p",
            measurement?.source
              ? `${measurement.source} · ${measurement.timestamp}`
              : measurement?.reason ||
                  (!snapshot ? missing : "No OS observation was collected."),
          ),
        );
        return d;
      }),
    );
  }
  extraGrid.append(
    el("div", "Terminal launch → observed readiness / ms"),
    ...[a, b].map((r) => {
      const launch = r?.evidence?.launch,
        d = el(
          "div",
          numeric(launch?.duration_ms)
            ? fmt(launch.duration_ms)
            : "Not collected · start with demo.sh",
        );
      if (launch)
        d.append(
          el(
            "p",
            `${launch.source} · ${launch.timestamp}. Poll interval ${launch.polling_interval_ms} ms. Not Kubernetes readiness.`,
          ),
        );
      return d;
    }),
  );
  extraGrid.append(
    el("div", "Uptime at StartupEvent / ms"),
    ...[a, b].map((r) => {
      const value = saved(r)?.readiness?.checks?.find(
        (x) => x.name === "app-readiness",
      )?.data?.startup_time_ms;
      return el("div", fmt(value));
    }),
  );
  for (const [key, label] of [
    ["build_seconds", "Build time / seconds"],
    ["peak_build_mib", "Peak build process RSS / MiB"],
    ["artifact_bytes", "Artifact / bytes"],
    ["image_bytes", "Container image / bytes"],
  ]) {
    extraGrid.append(
      el("div", label),
      ...[a, b].map((r) => {
        const d = el(
          "div",
          numeric(r?.costs?.[key])
            ? fmt(r.costs[key])
            : key === "image_bytes" && r?.evidence?.environment_mode === "host"
              ? "Not applicable · no container image built"
              : "Not collected",
        );
        if (numeric(r?.costs?.[key]))
          d.append(el("p", `${r.costs.source} · ${r.costs.timestamp}`));
        return d;
      }),
    );
  }
  $("comparison").replaceChildren(grid, extra);
  const warnings = settingsWarnings(a, b);
  $("warnings").textContent = warnings.length
    ? `Comparison is not established as controlled. ${warnings.join(" · ")}`
    : "Recorded settings match. Sequential local runs still differ in JIT history, cache state and host activity.";
}
const settings = ["revision", "cpu", "heap", "memory", "flags", "environment"];
const costs = [
  "build_seconds",
  "peak_build_mib",
  "artifact_bytes",
  "image_bytes",
  "source",
  "timestamp",
];
for (const key of settings) {
  const label = el(
    "label",
    {
      cpu: "CPU quota / affinity",
      heap: "Heap flags",
      memory: "Container memory limit",
      flags: "Other runtime flags",
      environment: "OS, hardware and environment",
      revision: "Source revision",
    }[key],
  );
  const input = el("input", "");
  input.id = `setting-${key}`;
  label.append(input);
  $("settings-fields").append(label);
}
for (const key of costs) {
  const label = el("label", key.replaceAll("_", " ")),
    input = el("input", "");
  input.id = `cost-${key}`;
  if (!["source", "timestamp"].includes(key)) {
    input.type = "number";
    input.min = "0";
    input.step = "any";
  }
  label.append(input);
  $("cost-fields").append(label);
}
function editingRun() {
  return session.runs.find((r) => r.id === $("settings-run").value);
}
function fillRunFields() {
  const r = editingRun();
  for (const k of settings)
    $(`setting-${k}`).value =
      (k === "revision" ? r?.revision : r?.settings?.[k]) || "";
  for (const k of costs) $(`cost-${k}`).value = r?.costs?.[k] ?? "";
}
$("settings-run").onchange = () => {
  $("settings-run").dataset.loaded = $("settings-run").value;
  fillRunFields();
};
$("save-settings").onclick = () => {
  const r = editingRun();
  if (!r) return tell("Select a process run first.");
  if (busy || r.samples.length)
    return tell(
      "Settings are locked after samples are collected. Start a new process run to change conditions.",
    );
  for (const k of settings) {
    if (k === "revision") r.revision = $(`setting-${k}`).value.trim();
    else r.settings[k] = $(`setting-${k}`).value.trim();
  }
  persist();
  render();
  tell("Run settings recorded.");
};
$("save-costs").onclick = () => {
  const r = editingRun();
  if (!r) return tell("Select a process run first.");
  const c = {};
  for (const k of costs) {
    const v = $(`cost-${k}`).value.trim();
    c[k] =
      v === "" ? null : ["source", "timestamp"].includes(k) ? v : Number(v);
  }
  if (costs.slice(0, 4).some((k) => c[k] !== null && !numeric(c[k])))
    return tell("Costs must be non-negative numbers.");
  if (!c.source || !Number.isFinite(Date.parse(c.timestamp)))
    return tell("Provide a build measurement source and ISO timestamp.");
  r.costs = c;
  persist();
  render();
};
function renderObservations() {
  $("observations").replaceChildren(
    ...(session.observations.length
      ? session.observations.map((o) => el("pre", JSON.stringify(o, null, 2)))
      : [
          el(
            "p",
            "Not collected. Image bytes, resource requests/limits and external readiness observations remain unavailable.",
          ),
        ]),
  );
}
$("add-observation").onclick = () => {
  try {
    const o = JSON.parse($("observation-json").value);
    if (
      !["jvm", "native-image"].includes(o?.runtime) ||
      typeof o.source !== "string" ||
      !o.source.trim() ||
      !Number.isFinite(Date.parse(o.timestamp))
    )
      throw Error("runtime, source and timestamp are required");
    session.observations.push({
      ...o,
      provenance: "imported external observation",
    });
    persist();
    render();
    tell("Imported external observation; not live telemetry.");
  } catch (e) {
    tell(e.message);
  }
};
async function request(url, timeout = 4000, allowDown = false) {
  const controller = new AbortController(),
    t = setTimeout(() => controller.abort(), timeout);
  try {
    const start = performance.now(),
      r = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!r.ok && !(allowDown && r.status === 503))
      throw Error(`HTTP ${r.status}`);
    const text = await r.text(),
      httpMs = performance.now() - start;
    return { data: JSON.parse(text), httpMs };
  } finally {
    clearTimeout(t);
  }
}
async function poll() {
  if (busy) return;
  if (polling) return polling;
  polling = (async () => {
    try {
      const next = (await request("/perf/info")).data;
      const previous = active?.id;
      const reset = reconcileReset(session, next, preserveImportedOnNextPoll);
      preserveImportedOnNextPoll = false;
      if (reset.cleared) {
        session = reset.session;
        active = null;
        selected = { jvm: null, "native-image": null };
        localStorage.removeItem(KEY);
        localStorage.removeItem(LEGACY_KEY);
        for (const id of ["settings-run", "jvm-run", "native-run"]) {
          delete $(id).dataset.signature;
          delete $(id).dataset.loaded;
          $(id).replaceChildren();
        }
        $("session-name").value = session.name;
        $("revision").value = "";
        tell(
          "Terminal reset detected. Previous comparison cleared; save this runtime’s pre-load baseline to begin.",
        );
      }
      active = observe(session, next);
      const image =
        next.demo_evidence?.status === "collected"
          ? next.demo_evidence.data?.image
          : null;
      if (
        image?.builder === "quarkus-container-image-jib" &&
        image.source_hash === next.demo_evidence.data.source_hash
      ) {
        session.deployment.receipt = structuredClone(image);
        if (!session.deployment.selectedByUser) {
          session.deployment.image = image.image;
          session.deployment.platform = image.platform;
        }
      }
      const scale =
        next.demo_evidence?.status === "collected"
          ? next.demo_evidence.data?.scale
          : null;
      if (scale?.kind === "scale")
        session.deployment.scale = structuredClone(scale);
      info = next;
      if (session.phase === 5 && clusterControl?.enabled) {
        try {
          await checkClusterControl();
        } catch {
          /* A control failure is separate from the benchmark connection. */
        }
      }
      if (
        session.phase === 2 &&
        session.switchFrom &&
        active.id !== session.switchFrom
      ) {
        session.phase = 0;
        session.benchmark = "fib";
        tell(
          "Other process connected. Save its pre-load baseline now, then run the same samples.",
        );
      }
      connected = true;
      backoff = 1000;
      if (previous && previous !== active.id && !reset.cleared)
        tell(
          `New process detected (${active.runtime}). Previous results preserved. Start → save pre-load baseline → Load.`,
        );
      try {
        health = (await request("/q/health/ready", 4000, true)).data;
      } catch {
        health = null;
      }
      persist();
    } catch (e) {
      connected = false;
      info = null;
      health = null;
      backoff = Math.min(backoff * 2, 15000);
      tell(`Backend unavailable: ${e.message}. Saved results preserved.`);
    } finally {
      polling = null;
      render();
      if (!busy) timer = setTimeout(poll, backoff);
    }
  })();
  return polling;
}
async function run(count) {
  if (busy || !connected || !active) return;
  busy = true;
  clearTimeout(timer);
  render();
  try {
    if (polling) await polling;
    clearTimeout(timer);
    const run = active;
    if (!connected || !run) throw Error("Backend unavailable");
    const report = await batch(
      run,
      count,
      () => request(BENCHMARKS[session.benchmark].url, 30000),
      () => {
        persist();
        render();
      },
      session.benchmark,
    );
    persist();
    $("batch-status").textContent =
      `${report.completed}/${report.requested} successful${report.error ? ` · partial/failed batch: ${report.error}` : " · complete"}`;
    if (report.error)
      tell(
        "Batch stopped. Successful measurements retained; failed or changed-process responses excluded.",
      );
  } catch (e) {
    tell(e.message);
  } finally {
    busy = false;
    render();
    timer = setTimeout(poll, 1000);
  }
}
$("first").onclick = () => run(1);
$("more").onclick = () => run(5);
async function captureSnapshot(kind) {
  if (busy || !connected || !active) return false;
  busy = true;
  clearTimeout(timer);
  render();
  try {
    if (polling) await polling;
    clearTimeout(timer);
    const next = (await request("/perf/info")).data;
    if (next.process_id !== active.id)
      throw Error("Process changed. Wait for reconnection before saving.");
    info = next;
    active = observe(session, next);
    try {
      health = (await request("/q/health/ready", 4000, true)).data;
    } catch {
      health = null;
    }
    const healthProcess = health?.checks?.find(
      (x) => x.name === "app-readiness",
    )?.data?.process_id;
    if (healthProcess && healthProcess !== next.process_id)
      throw Error(
        "Process changed while collecting readiness. Wait for reconnection.",
      );
    recordSnapshot(active, info, health, kind);
    persist();
    return true;
  } catch (e) {
    tell(e.message);
    return false;
  } finally {
    busy = false;
    render();
    timer = setTimeout(poll, 1000);
  }
}
$("primary").onclick = async () => {
  if (session.phase === 0) {
    if (active?.samples.length && !baseline(active)) {
      tell(
        "Pre-load baseline was missed for this process. Existing results remain; restart the runtime for a fresh baseline.",
      );
      session.phase = 1;
    } else if (await captureSnapshot("pre-load")) {
      tell("Pre-load baseline saved. Click Run first sample, then Run 5 more.");
      session.phase = 1;
    }
  } else if (session.phase === 1) {
    if (await captureSnapshot("post-load")) {
      if (
        session.runs.some(
          (r) => r.runtime !== active.runtime && r.samples.length,
        )
      ) {
        session.phase = 3;
        tell("");
      } else {
        session.switchFrom = active.id;
        session.phase = 2;
        tell("Post-load snapshot saved. In the terminal run ./demo.sh switch.");
      }
    }
  } else if (session.phase === 2) session.phase = 0;
  else if (session.phase === 3) session.phase = 4;
  else if (session.phase === 4) session.phase = 5;
  else exportSession();
  persist();
  render();
};
for (const id of ["load-benchmark", "compare-benchmark"])
  $(id).onchange = () => {
    if (busy) return;
    session.benchmark = $(id).value;
    persist();
    render();
  };
$("reset-session").onclick = async () => {
  if (busy) return tell("Wait for the current action to finish.");
  if (
    !window.confirm(
      "Clear all browser-saved comparison results and snapshots? Export first if you need them. Build artifacts are cleared separately with ./demo.sh reset.",
    )
  )
    return;
  clearTimeout(timer);
  if (polling) await polling;
  clearTimeout(timer);
  const theme = session.theme,
    generation = session.backendGeneration;
  localStorage.removeItem(KEY);
  localStorage.removeItem(LEGACY_KEY);
  session = fresh();
  session.theme = theme;
  if (generation) session.backendGeneration = generation;
  active = null;
  info = null;
  health = null;
  connected = false;
  selected = { jvm: null, "native-image": null };
  for (const id of ["settings-run", "jvm-run", "native-run"]) {
    delete $(id).dataset.signature;
    delete $(id).dataset.loaded;
    $(id).replaceChildren();
  }
  $("session-name").value = session.name;
  $("revision").value = "";
  persist();
  render();
  tell(
    "New comparison session. For a fresh process, use ./demo.sh down then ./demo.sh up.",
  );
  poll();
};
async function copyText(text) {
  if (!text)
    return tell("Enter a valid tagged image reference and platform first.");
  try {
    await navigator.clipboard.writeText(text);
    tell(
      "Copied. Execute commands in the terminal; the browser does not run them.",
    );
  } catch {
    tell("Clipboard unavailable. Select and copy the displayed text manually.");
  }
}
function renderDeployment() {
  const settings = session.deployment || deploymentDefaults(),
    commands = deploymentCommands(settings),
    receipt = matchingReceipt(settings);
  for (const [id, key] of [
    ["container-image", "image"],
    ["container-platform", "platform"],
    ["openshift-console", "consoleUrl"],
    ["openshift-project", "namespace"],
    ["openshift-deployment", "deployment"],
    ["application-url", "applicationUrl"],
  ])
    if (document.activeElement !== $(id)) $(id).value = settings[key] || "";

  $("podman-command").textContent =
    commands?.run || "Choose a valid image first.";
  $("copy-podman-run").disabled = !commands;
  const reference = deployReference(settings);
  $("deploy-image-reference").textContent =
    reference || "Configure a tagged image in 05 Containerize first.";
  $("copy-deploy-image").disabled = !reference;
  const link = consoleLink(settings.consoleUrl);
  if (link) {
    $("open-openshift").href = link;
    $("open-openshift").removeAttribute("aria-disabled");
  } else {
    $("open-openshift").removeAttribute("href");
    $("open-openshift").setAttribute("aria-disabled", "true");
  }
  const panel = $("image-evidence");
  panel.replaceChildren();
  if (receipt) {
    panel.append(
      el(
        "h3",
        receipt.published
          ? "Recorded Jib build + push"
          : "Recorded Jib build + local load",
      ),
      el("p", `${receipt.image} · ${receipt.platform}`, "image-reference"),
      el("p", receipt.digest, "image-reference"),
      el(
        "p",
        `Image build: ${fmt(receipt.build_seconds, " s")} · local image bytes: ${numeric(receipt.image_bytes) ? fmt(receipt.image_bytes) : "not collected"}`,
      ),
      el(
        "p",
        `${receipt.image_size_source} · ${receipt.source} · ${receipt.timestamp}`,
        "footnote",
      ),
    );
  } else
    panel.append(
      el("h3", "No matching image receipt"),
      el(
        "p",
        "No matching image has been recorded for this selection. Prepare/push it before presenting with demo.sh prepare --image ... --push-image. A successful Quarkus Jib build writes a receipt; source-matched receipts attach on the next poll. A configured pre-pushed tag is not automatically verified.",
      ),
    );
  const scaling = scaleCommands(settings);
  const controlMatches =
    clusterControl?.enabled &&
    clusterControl.namespace === settings.namespace &&
    clusterControl.deployment === settings.deployment;
  $("direct-scale-out").disabled =
    busy || !connected || !controlMatches || clusterControl.running;
  $("direct-scale-in").disabled =
    busy || !connected || !controlMatches || clusterControl.running;
  if (clusterControl)
    $("control-status").textContent = clusterControl.enabled
      ? `Local controller: ${clusterControl.namespace}/${clusterControl.deployment} · context ${clusterControl.context || "unknown"} · API ${clusterControl.api_server || "unknown"} · ${clusterControl.running ? "observing; actions locked" : "ready"}${controlMatches ? "" : ". Form target differs; match the configured local target to enable buttons."}`
      : clusterControl.reason;
  $("scale-out-command").textContent =
    scaling?.out || "Enter valid project and Deployment names.";
  $("scale-in-command").textContent = scaling?.inside || "";
  $("copy-scale-out").disabled = !scaling;
  $("copy-scale-in").disabled = !scaling;
  const route = consoleLink(settings.applicationUrl);
  if (route) {
    $("open-route").href = route;
    $("open-route").removeAttribute("aria-disabled");
  } else {
    $("open-route").removeAttribute("href");
    $("open-route").setAttribute("aria-disabled", "true");
  }
  const recorded = settings.scale,
    panelScale = $("scale-evidence");
  panelScale.replaceChildren();
  if (recorded) {
    panelScale.append(
      el(
        "h3",
        `Recorded scale: ${recorded.from_replicas ?? "unknown"} → ${recorded.target} · ${recorded.status}`,
      ),
      el(
        "p",
        `${recorded.namespace}/${recorded.deployment} · ${numeric(recorded.duration_ms) ? fmt(recorded.duration_ms / 1000, " s") : "target convergence not measured"}`,
      ),
      el("p", `${recorded.boundary} · ${recorded.timestamp}`, "footnote"),
    );
    if (recorded.reason) panelScale.append(el("p", recorded.reason));
    const trace = el(
      "pre",
      (recorded.timeline || [])
        .map(
          (row) =>
            `${(row.elapsed_ms / 1000).toFixed(1)}s   Ready ${row.ready}/${recorded.target}   Available ${row.available}   Pending ${row.pending}   Terminating ${row.terminating}`,
        )
        .join("\n"),
    );
    panelScale.append(trace);
    panelScale.append(
      el(
        "p",
        "Recorded controller/owned-pod convergence, not per-pod startup or an SLO. Route access may succeed before all replicas are ready.",
        "footnote",
      ),
    );
  } else
    panelScale.append(
      el(
        "p",
        "Not collected. Run the scale command after deployment. API polling, scheduling, image pull, probes and termination all contribute to the observation.",
      ),
    );
}
for (const [id, key] of [
  ["container-image", "image"],
  ["container-platform", "platform"],
  ["openshift-console", "consoleUrl"],
  ["openshift-project", "namespace"],
  ["openshift-deployment", "deployment"],
  ["application-url", "applicationUrl"],
])
  $(id).onchange = () => {
    session.deployment[key] = $(id).value.trim();
    if (key === "image" || key === "platform")
      session.deployment.selectedByUser = true;
    persist();
    renderDeployment();
  };
$("copy-podman-run").onclick = () =>
  copyText(deploymentCommands(session.deployment)?.run);
$("copy-deploy-image").onclick = async () => {
  const ref = deployReference(session.deployment);
  if (!ref) return tell("Configure a tagged image first.");
  try {
    await navigator.clipboard.writeText(ref);
    tell(
      "Image reference copied. Open the prepared project in OpenShift, then Add to Project → Container Image.",
    );
  } catch {
    tell("Select and copy the displayed image reference manually.");
  }
};
$("copy-scale-out").onclick = () =>
  copyText(scaleCommands(session.deployment)?.out);
$("copy-scale-in").onclick = () =>
  copyText(scaleCommands(session.deployment)?.inside);
async function checkClusterControl() {
  if (busy) return;
  const result = (await request("/demo/cluster-control", 6000)).data;
  clusterControl = result; // Ephemeral capability token; never saved or exported.
  if (result.observation?.kind === "scale") {
    session.deployment.scale = result.observation;
    persist();
  }
  renderDeployment();
}
$("connect-control").onclick = async () => {
  try {
    await checkClusterControl();
  } catch (e) {
    clusterControl = null;
    $("control-status").textContent =
      `Local control unavailable: ${e.message}. Check login, enable it locally, or use the copy commands.`;
  }
};
async function directScale(replicas) {
  if (busy || !connected || !clusterControl?.enabled || clusterControl.running)
    return;
  if (
    !confirm(
      `Scale ${clusterControl.namespace}/${clusterControl.deployment} to ${replicas} replicas in context ${clusterControl.context || "unknown"} (${clusterControl.api_server || "verify local API server"})? This changes the real cluster. Timeout does not roll back the change.`,
    )
  )
    return;
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch("/demo/cluster-control/scale", {
      method: "POST",
      credentials: "same-origin",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Demo-Control": clusterControl.token,
      },
      body: JSON.stringify({ replicas }),
    });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    clusterControl.running = true;
    renderDeployment();
    await checkClusterControl();
  } catch (e) {
    $("control-status").textContent =
      `Scale request was not confirmed: ${e.message}. Check controller status and the console before retrying; an aborted browser request does not cancel a server operation.`;
  } finally {
    clearTimeout(timeout);
  }
}
$("direct-scale-out").onclick = () => directScale(100);
$("direct-scale-in").onclick = () => directScale(1);
$("check-route").onclick = async () => {
  const address = consoleLink(session.deployment.applicationUrl);
  if (!address) return tell("Enter an HTTPS application Route URL first.");
  const button = $("check-route");
  button.disabled = true;
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 5000),
    start = performance.now();
  try {
    const url = new URL(address);
    url.pathname = url.pathname.replace(/\/$/, "") + "/q/health/ready";
    url.search = "";
    url.hash = "";
    const response = await fetch(url, {
        signal: controller.signal,
        cache: "no-store",
        mode: "cors",
        credentials: "omit",
      }),
      data = await response.json();
    $("route-status").textContent =
      `Route observation ${url.origin}${url.pathname} at ${new Date().toISOString()}: HTTP ${response.status}, readiness ${data.status || "unknown"}, browser HTTP ${(performance.now() - start).toFixed(1)} ms. One routed response does not establish that all replicas are ready.`;
  } catch (error) {
    $("route-status").textContent =
      `Route could not be checked: ${error.message}. This may be network, TLS or CORS; it is not a benchmark failure. Open the Route directly or check the image's allowed dashboard origin.`;
  } finally {
    clearTimeout(timer);
    button.disabled = false;
  }
};
$("open-openshift").onclick = (e) => {
  if (!consoleLink(session.deployment.consoleUrl)) {
    e.preventDefault();
    tell(
      "Enter an HTTPS console or Topology URL, without embedded credentials or login callback tokens.",
    );
  }
};
$("theme").onclick = () => {
  session.theme = session.theme === "dark" ? "light" : "dark";
  persist();
  render();
};
$("fullscreen").onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (e) {
    tell(`Fullscreen unavailable: ${e.message}`);
  }
};
$("session-name").value = session.name;
$("revision").value = session.revision;
$("session-name").onchange = () => {
  session.name = $("session-name").value;
  persist();
};
$("revision").onchange = () => {
  session.revision = $("revision").value;
  persist();
};
function exportSession() {
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(session, null, 2)], {
        type: "application/json",
      }),
    ),
    a = el("a", "");
  a.href = url;
  a.download = "runtime-lab-session.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("export").onclick = exportSession;
$("import").onchange = async (e) => {
  try {
    if (busy) throw Error("Wait for the benchmark batch to finish");
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5e6) throw Error("Session exceeds 5 MB");
    const next = decode(await file.text());
    clearTimeout(timer);
    if (polling) await polling;
    clearTimeout(timer);
    session = next;
    preserveImportedOnNextPoll = true;
    delete $("settings-run").dataset.loaded;
    delete $("settings-run").dataset.signature;
    active = null;
    connected = false;
    info = null;
    health = null;
    selected = { jvm: null, "native-image": null };
    $("session-name").value = session.name;
    $("revision").value = session.revision;
    persist();
    render();
    tell("Imported saved session. Live identity will be detected separately.");
    poll();
  } catch (e) {
    tell(`Import rejected: ${e.message}`);
  } finally {
    e.target.value = "";
  }
};
render();
poll();
