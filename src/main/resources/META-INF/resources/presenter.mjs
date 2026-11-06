import {
  fresh,
  KEY,
  LEGACY_KEY,
  BENCHMARKS,
  samplesFor,
  baseline,
  postload,
  snapshot as recordSnapshot,
  insight,
  load,
  save,
  decode,
  observe,
  stats,
  compare,
  settingsWarnings,
  numeric,
  batch,
} from "./session.mjs?v=20261106-2";
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
    "Continue to Kubernetes",
  ],
  [
    "Kubernetes",
    "From process to Ready.",
    "Bring external observations into the story without conflating readiness and performance.",
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
  ["start", "load", "switch", "compare", "kubernetes"].forEach(
    (id, i) => ($(id).hidden = session.phase !== i),
  );
  $("connection").textContent = busy
    ? "Benchmarking · polling paused"
    : connected
      ? "Connected · live"
      : "Disconnected / reconnecting";
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
    if (!runs.length) select.append(new Option("Not collected", ""));
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
function renderComparison() {
  const benchmark = session.benchmark;
  const a = selectedRun("jvm"),
    b = selectedRun("native-image"),
    grid = el("div", "", "compare-grid");
  $("computation-insight").textContent = insight(a, b, benchmark);
  $("insight-workload").textContent = BENCHMARKS[benchmark].description;
  grid.append(
    el("div", "MEASUREMENT"),
    el("div", "JVM", "jvm big"),
    el("div", "NATIVE IMAGE", "native big"),
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
      active = observe(session, next);
      info = next;
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
      if (previous && previous !== active.id)
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
        tell(
          "Post-load snapshot saved. Compare the same workload and review the insights.",
        );
      } else {
        session.switchFrom = active.id;
        session.phase = 2;
        tell("Post-load snapshot saved. In the terminal run ./demo.sh switch.");
      }
    }
  } else if (session.phase === 2) session.phase = 0;
  else if (session.phase === 3) session.phase = 4;
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
  const theme = session.theme;
  localStorage.removeItem(KEY);
  localStorage.removeItem(LEGACY_KEY);
  session = fresh();
  session.theme = theme;
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
