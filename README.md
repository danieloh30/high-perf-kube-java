# Runtime Lab: JVM versus Native Image

A presentation-ready SPA served by the existing Quarkus application. The guided
story is **Start → Load → Switch runtime → Compare → Kubernetes readiness**.
Java 25 · Quarkus 3.40.1.1 · all assets bundled locally.

Open http://localhost:8080. Read [DEMO.md](DEMO.md) for preparation commands,
a 5–7 minute presenter script, packaged JVM/native execution, build-cost recording,
optional Kubernetes observations and curl fallback.

## Presenter features

- High-contrast light/dark themes, fullscreen and 1080p projector layout.
- Runtime identity, live connection state, bounded reconnect requests with backoff.
- Versioned browser-local sessions, named comparisons, settings, snapshots and
  complete JSON export/import. Saved observations are separate from live metrics.
- Deliberate fib(40) calls using `duration_ns`; first sample separate from repeated
  count, median, min and max. No benchmark requests on connect, poll or navigation.
- Process identities on info and benchmark responses prevent results mixing after
  runtime changes or same-runtime restarts. Partial failures retain successful calls.
- Comparisons check input and output agreement; server and browser durations have
  separate boundaries. Unknown/different resource settings are visible.
- Build time, peak build memory, artifact bytes and image bytes are recorded
  separately with measurement source and timestamp, or remain “not collected.”
- Optional imported Kubernetes observations; no cluster or shell access in the SPA.

Sessions use localStorage key `runtime-lab.session.v1`. Export before clearing
browser data or changing origin. Invalid/unsupported JSON imports are rejected.
Session details contain individual samples, baseline snapshots, definitions and raw
JSON. Run settings lock after sampling to preserve the recorded conditions.

## Existing endpoints (preserved)

- `/hello`, `/hello/perf`, `/hello/runtime`: greeting and runtime text.
- `/perf/info`: runtime, Java/VM identity, uptime, heap/non-heap and processors.
  Includes `process_id` and `process_start_epoch_ms` for process identification.
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
`demo-artifacts/jvm/` and `demo-artifacts/native/` directories.

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
