# JVM versus Native Image: a 6-minute rehearsal

This checkout uses Java 25 and Quarkus 3.40.1.1. All browser assets are local.
Use the same machine, port, source revision and browser origin throughout.
Do not compare dev mode with native. Prebuild both artifacts before the talk.

## Prepare once, before presenting

From the repository root:

```sh
./demo.sh up
```

On the first run, this checks prerequisites, packages **both** runtimes, preserves
separate artifacts, records build costs, starts the packaged JVM application in
the background, and waits for `/perf/info` plus `/q/health/ready`. Open
http://localhost:8080. No benchmark is run by the script.

Prerequisites: macOS or Linux, Python 3.9+, Git, and **GraalVM JDK 25 with
native-image**. Set `JAVA_HOME` to that GraalVM installation. Maven uses the
repository wrapper; the first build needs dependency downloads. Stop this
checkout's dev mode first (MCP: `quarkus_stop`); the script refuses to build over
it or take over an occupied port. Native compilation can take several minutes.
It builds a host-native executable, so a Linux container runtime is not required.

Prebuild before the talk without starting the application:

```sh
./demo.sh prepare
./demo.sh costs
```

`up` and `prepare` reuse the pair when application sources, POM, wrapper and host
match and both artifact digests validate. Changed sources trigger a new pair;
use `./demo.sh down` before rebuilding a running demo. A failed build never
replaces the last complete pair. Force a fresh build after changing the compiler,
Maven settings or build environment:

```sh
./demo.sh prepare --force
```

Artifacts live in timestamped `demo-artifacts/builds/` bundles, each with separate
`jvm/quarkus-app/` and `native/app` outputs. `demo-artifacts/current.json` selects
the last complete pair. Bundles contain revision, dirty-checkout status, source
hash, toolchain versions, build logs and cost JSON. Earlier bundles are retained;
the script does not delete them. Only a complete two-runtime build becomes current.

The script delegates packaging to `./mvnw package -DskipTests` and the existing
native profile, with container-image creation/push disabled. Run tests separately
before preparing. Host `/usr/bin/time` records peak build RSS on macOS/Linux;
elapsed wall time and exact artifact bytes are also collected. Image bytes remain
not collected. Inspect the JSON from `costs` and enter its measured values,
source and timestamp into the SPA's selected run. These files are build evidence,
not benchmark samples. Build time includes Maven work and depends on cache state.
Peak build RSS is not container-wide memory. Artifact bytes are not image bytes.

## Run the prepared artifacts

```sh
./demo.sh up              # packaged JVM; reuses prebuilt pair
./demo.sh status          # actual runtime, readiness, PID, log and launch flags
./demo.sh logs            # last 80 lines of the current runtime log
```

Set the session name and source revision in the SPA. Select light or dark theme,
then record the current run's settings **before** sampling. Defaults for both:
`-Xms64m -Xmx256m -XX:ActiveProcessorCount=2`, port 8080, loopback HTTP binding.
Record CPU as `ActiveProcessorCount=2; no OS quota`, container limit as
`none (host run)` and the exact flags/environment printed by `status`.
The script verifies the reported runtime and processor count before declaring it
ready. Settings are declarations, not verified host isolation; equal heap flags
do not imply equal RSS or memory limits. SPA run settings lock after sampling.

At “Save baseline and switch runtime”, keep the browser open and use the terminal:

```sh
./demo.sh switch          # JVM → Native Image, or Native Image → JVM
./demo.sh switch native   # explicitly choose Native Image; no build
./demo.sh switch jvm      # explicitly choose JVM; no build
./demo.sh down            # stop only the process owned by this script
```

Switch validates the prepared pair before stopping, preserves the running port,
CPU and heap settings, pauses briefly for the SPA's disconnect state, then starts
the other artifact. It never benchmarks, rebuilds, clears localStorage or controls
an unrelated process. If launch fails, inspect `logs` and run `up jvm` to recover.
No process-control endpoint is exposed to the browser. Stop/start observation by
the browser is still not a startup measurement.

Optional settings apply to `up` (switch preserves the existing launch settings):

```sh
DEMO_PORT=8080 DEMO_CPUS=2 DEMO_XMS=64m DEMO_XMX=256m ./demo.sh up
./demo.sh up native       # start native directly after down
```

The script prints the dashboard URL without opening a browser automatically.
Keep the same origin to preserve the session. For stronger isolation, separately
prepare containers on the same architecture with matching CPU quota and memory
limits. Record image build/pull costs separately from local artifact build costs.

## Presenter script (5–7 minutes)

1. **0:00–1:00 / Start.** “This is the actual running process.” Show runtime,
   processors, heap and non-heap MiB. Explain that process uptime and “Uptime at
   StartupEvent” are not end-to-end startup or Kubernetes readiness. Save baseline.
2. **1:00–2:00 / Load.** Run first sample, then Run 5 more. “First in this session
   for this process; other clients may already have called it.” Read the first
   server duration, repeated median and range. Expand details for individual calls.
3. **2:00–3:00 / Switch runtime.** Save baseline and switch runtime. Keep the SPA
   open. Run `./demo.sh switch` to launch the prebuilt native artifact. Let the
   disconnected state and reconnection show; results survive. Record the new run's settings.
4. **3:00–4:00 / Load again.** Run first sample, then Run 5 more on native.
   Verify result agreement. A partial batch shows completed/requested and an error;
   successful calls remain, failed calls do not become zeroes. Retry deliberately.
5. **4:00–5:00 / Compare.** Select the two process runs. Compare first samples
   separately from repeated medians. Server computation excludes HTTP overhead;
   browser HTTP includes it. Explain unknown or different resource settings.
   Show separately recorded build time, peak build memory and artifact/image bytes.
6. **5:00–6:00 / Kubernetes readiness.** Show external observations if collected,
   or “not collected.” Scheduling, image pull, process start, readiness and load
   performance have different boundaries. A Ready pod does not establish an SLO.
   Export the complete session as JSON.

Local sequential calls illustrate these runs, not sustained throughput, p99,
steady state or a causal performance claim. JIT history, GC, OS caches, thermal
state, background work and order effects remain. Repeat with reversed order and
fresh processes when investigating results. Reloading the browser does not reset
a process. Restarting the process creates a distinct run, including same-runtime
restarts. Imported sessions are saved observations; live metrics always come from
the connected backend. Stay on the same origin to retain localStorage.

## Optional Kubernetes collection (separate from the app)

No cluster collector or deployment manifests existed in this repository. The
existing Jib extension can build images; deployment and observation remain an
external workflow. Do not add browser process-control endpoints.

After deploying prepared images with equivalent requests, limits and probe
configuration, preserve raw evidence (replace namespace and pod):

```sh
kubectl -n demo get pod POD -o json > pod.json
kubectl -n demo get events --field-selector involvedObject.name=POD -o json > events.json
kubectl -n demo logs POD --timestamps > process.log
kubectl -n demo get pod POD -o jsonpath='{.spec.containers[*].resources}'
kubectl -n demo wait --for=condition=Ready pod/POD --timeout=120s
```

`wait` duration starts at command invocation, not pod creation. Read condition
transition timestamps, scheduled conditions, container startedAt and image-pull
events; events can be coarse, missing or aggregated. Record clock assumptions and
boundaries. Retrieve image bytes from the registry manifest or image inspection,
including whether bytes are compressed, architecture and digest. Keep requests,
limits, measured usage and peak build memory separate. Collect throughput/latency
with a separately described load test; never derive an SLO from Ready.

Paste an observation object into Session details. It must include `runtime`
(`jvm` or `native-image`), `source`, and an ISO-8601 `timestamp`. Optional keys:
`image_bytes`, `requests`, `limits`, `scheduling`, `image_pull`, `process_start`,
`readiness`, `under_load`. Timing values should include units and explicit
start/end boundaries. It is displayed as **imported external observation**, never
live telemetry. Missing keys remain not collected; no example measurements ship.

## Curl fallback

These requests use the unchanged algorithms and endpoint names. Only the explicit
benchmark requests perform benchmark work; readiness and info do not.

```sh
curl -fsS http://localhost:8080/perf/info
curl -fsS http://localhost:8080/q/health/ready
curl -fsS 'http://localhost:8080/perf/fib?n=40'
for i in 1 2 3 4 5; do curl -fsS 'http://localhost:8080/perf/fib?n=40'; printf '\n'; done
curl -fsS 'http://localhost:8080/perf/primes?limit=1000000'
curl -fsS http://localhost:8080/q/metrics
```

## Verification

```sh
npm ci
npm test
python3 -m unittest discover -s tests -p 'test_demo.py'
npx playwright install chromium
# With the app already running on 8080:
npm run test:browser
```

Browser tests use real backend requests for the presenter smoke test. Test-only
mocked responses exercise mismatches and partial failures and never enter the
live app bundle. The browser test checks a 1920×1080 viewport and writes screenshots
to ignored `test-results/`. Run backend tests through `quarkus_callTool` toolName
`devui-testing_runTests`, as required by AGENTS.md. Agent verification used dev mode
for UI and integration tests. Script tests use isolated temporary build/runtime
fixtures; no fixture is copied into demo artifacts. Real packaging/native
execution remains a separate rehearsal check: AGENTS.md prohibits the agent from
running Maven manually and Dev MCP exposes no packaging operation.
