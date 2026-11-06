# Runtime Lab: JVM versus Native Image

A presentation-ready SPA served by the existing Quarkus application. The guided
story is **Start → Load → Switch runtime → Compare → Containerize → OpenShift**.
Java 25 · Quarkus 3.40.1.1 · all assets bundled locally.

Start the complete local workflow from this checkout:

```sh
./demo.sh up       # prepare both artifacts if needed, then start packaged JVM
./demo.sh switch   # switch to the other prepared runtime on the same port
./demo.sh down     # stop the script-owned process; keep artifacts
./demo.sh reset    # stop it and delete demo-artifacts contents plus target/
```

Requires macOS/Linux, Python 3.9+, and GraalVM JDK 25 with native-image.
GraalVM is discovered through `GRAALVM_HOME`, `JAVA_HOME`, `PATH`, or SDKMAN.
Use `./demo.sh prepare` before the talk, and `./demo.sh costs` for measured build
costs. Artifacts are preserved in separate timestamped bundles and reused until
application sources change. `status` and `logs` provide launch details.

Open http://localhost:8080. Read [DEMO.md](DEMO.md) for preparation commands,
a 5–7 minute presenter script, packaged JVM/native execution, build-cost recording,
optional Kubernetes observations and curl fallback.

For the optional container/cluster chapter, prepare and push the JVM image before presenting:

```sh
./demo.sh prepare --image quay.io/danieloh30/high-perf-java:jvm-demo --platform linux/amd64 --push-image
```

Choose your cluster's platform and configure registry credentials first. The build
explicitly uses `quarkus-container-image-jib`. See DEMO.md for local Podman checks,
console deployment and the 1 → 100 → 1 scaling exercise. No real registry push or
cluster scale is performed by repository tests.

## Presenter features

- High-contrast light/dark themes, fullscreen and 1080p projector layout.
- Presenter assets use no-store and versioned URLs to avoid stale controls after
  switching or rebuilding artifacts; older tabs may need one hard refresh.
- Runtime identity, live connection state, bounded reconnect requests with backoff.
- Versioned browser-local sessions, named comparisons, settings, snapshots and
  complete JSON export/import. Saved observations are separate from live metrics.
- Deliberate fib(40) calls using `duration_ns`; first sample separate from repeated
  count, median, min and max. No benchmark requests on connect, poll or navigation.
- Process identities on info and benchmark responses prevent results mixing after
  runtime changes or same-runtime restarts. Partial failures retain successful calls.
- Compare highlights AOT/JIT, computation, startup and memory with readable concept cards.
- Compare includes measured computation insights and an optional prime-sieve workload.
- Pre-load and post-load snapshots remain separate; missed baselines stay explicit.
- Comparisons check input and output agreement; server and browser durations have
  separate boundaries. Unknown/different resource settings are visible.
- Launcher build costs, artifact bytes, revision, launch settings and terminal-observed
  readiness time attach automatically through process-matched read-only evidence.
- OS process RSS is collected separately from heap; container cgroup usage is
  collected only when identified and readable. Image bytes are not applicable
  to the host executable workflow. External cluster/image observations stay labeled.
- Existing Jib extension builds a JVM image during `prepare --image … --push-image`;
  image work is isolated from host artifacts. The SPA displays image receipts.
- OpenShift console handoff copies a tag/digest and opens your configured Topology URL.
- A bounded Route readiness check separates browser access from replica readiness.
- `demo.sh scale --namespace … --deployment … --replicas 100` (then 1) records
  Ready/Available convergence through the authenticated oc CLI. The SPA displays
  timestamped observations; it has no shell or Kubernetes process-control endpoint.

Sessions use localStorage key `runtime-lab.session.v2`; v1 sessions migrate with
legacy snapshots labeled as having unknown phase. Export before clearing
browser data or changing origin. Invalid/unsupported JSON imports are rejected.
Session details contain individual samples, baseline snapshots, definitions and raw
JSON. Run settings lock after sampling to preserve the recorded conditions.
Reset comparison session clears saved browser results without changing the runtime.
Terminal `reset` clears generated artifacts and clears the old browser comparison
automatically when the next launched process reconnects. Export any results you need to retain first.

## Existing endpoints (preserved)

- `/hello`, `/hello/perf`, `/hello/runtime`: greeting and runtime text.
- `/perf/info`: runtime, Java/VM identity, uptime, heap/non-heap and processors.
  Includes `process_id` and `process_start_epoch_ms` for process identification,
  OS `process_rss`, `container_memory`, and process-matched `demo_evidence`.
  Evidence is read only from the launcher-configured file; there is no HTTP file
  path parameter or process-control endpoint.
- `/perf/fib?n=40`: naive recursive Fibonacci (1–45; invalid input defaults to 40).
- `/perf/primes?limit=1000000`: sieve (100–10,000,000; invalid input defaults to
  1,000,000). Retained as a secondary curl demo.
- Both benchmarks preserve results, `duration_ms` and `duration_ns` and add
  `process_id`. Algorithms and timing boundaries are unchanged.
- `/q/health`, `/q/health/live`, `/q/health/ready`: SmallRye Health.
- `/q/metrics`: Prometheus. `/q/dev/`: development-only Dev UI.

Historical `_mb` field names remain API-compatible, but divide by 1,048,576 and
are labeled **MiB** in the SPA. Undefined memory maxima are JSON null.
`startup_time_ms` remains API-compatible and means **Uptime at StartupEvent**,
not Kubernetes readiness or end-to-end startup. Browser connection time is never
used to infer startup. Heap, RSS, container usage and image size are distinct.
A Ready pod does not prove a throughput or latency SLO. Few sequential calls do
not establish steady state, sustained throughput or p99.

## Development and tests

Use Quarkus MCP `quarkus_start` for development and `quarkus_callTool` with
`devui-testing_runTests` for backend tests, following [AGENTS.md](AGENTS.md).
`npm ci && npm test` runs focused dependency-free session logic tests;
`npm run test:browser` checks the live SPA and test-only failure scenarios after
installing Playwright Chromium. See DEMO.md for details. Development mode is for
verification only; the comparison uses packaged artifacts preserved in separate
`demo-artifacts/builds/<bundle>/jvm/` and `native/` directories.
Run terminal orchestration tests with
`python3 -m unittest discover -s tests -p test_demo.py` (isolated test fixtures).

## Extensions and guides

Existing extensions are retained; no frontend migration or additional runtime
dependency is required:

- [Quarkus REST / Jackson](https://quarkus.io/guides/rest)
- [SmallRye Health](https://quarkus.io/guides/smallrye-health)
- [Micrometer / Prometheus](https://quarkus.io/guides/micrometer)
- [Container Image Jib](https://quarkus.io/guides/container-image#jib)
- [Native executable builds](https://quarkus.io/guides/building-native-image)

Logical follow-up: rehearse the packaged pair on the presentation machine, then
collect external Kubernetes readiness and controlled load-test evidence if needed.
