# JVM versus Native Image: a 6-minute rehearsal

This checkout uses Java 25 and Quarkus 3.40.1.1. All browser assets are local.
Use the same machine, port, source revision and browser origin throughout.
Do not compare dev mode with native. Prebuild both artifacts before the talk.

## Prepare once, before presenting

Stop dev mode using the Quarkus MCP `quarkus_stop` tool before packaging.
The following commands are for the presenter to run in the repository root.
The paths and flags match this POM; packaging was not executed by the coding
agent because AGENTS.md requires Dev MCP tooling and that tooling exposes no
packaging operation. Native execution additionally requires a matching local
GraalVM JDK 25 with `native-image`. A container-built Linux executable cannot
run directly on macOS.

```sh
java -version
native-image --version
git rev-parse HEAD
mkdir -p demo-artifacts/jvm demo-artifacts/native demo-artifacts/costs

# macOS: -l records maximum resident set size in bytes; -p gives elapsed seconds.
# Linux: replace `-lp` with `-v` (maximum RSS is in KiB).
/usr/bin/time -lp ./mvnw package -DskipTests \
  > demo-artifacts/costs/jvm-build.stdout 2> demo-artifacts/costs/jvm-build.time
cp -R target/quarkus-app demo-artifacts/jvm/

/usr/bin/time -lp ./mvnw package -Dnative -DskipTests \
  > demo-artifacts/costs/native-build.stdout 2> demo-artifacts/costs/native-build.time
cp target/high-perf-kube-java-1.0.0-SNAPSHOT-runner demo-artifacts/native/app

date -u +%Y-%m-%dT%H:%M:%SZ
# Byte counts: all fast-jar files versus the native executable.
python3 -c 'from pathlib import Path; p=Path("demo-artifacts/jvm/quarkus-app"); print("JVM artifact bytes:",sum(f.stat().st_size for f in p.rglob("*") if f.is_file())); print("Native artifact bytes:",Path("demo-artifacts/native/app").stat().st_size)'
```

Check each command's exit status before copying. Use empty artifact destination
directories for a new preparation to avoid stale library files. The preserved
JVM copy survives a subsequent native build in `target`. Record revision,
build timestamp, elapsed seconds, peak build memory, compiler/version and machine
in Session details. Convert macOS peak RSS bytes to MiB by dividing by 1,048,576;
Linux KiB by 1,024. A local process RSS maximum is not a container-wide peak.
For container builds measure the builder container externally instead; otherwise
leave peak build memory not collected. Artifact bytes are not container image bytes.
Build costs include Maven work and depend on cache state; record whether caches
were warm. Build logs are source evidence, not benchmark samples.

## Run the prepared artifacts

Terminal A, JVM:

```sh
java -Xms64m -Xmx256m -XX:ActiveProcessorCount=2 \
  -Dquarkus.http.port=8080 \
  -jar demo-artifacts/jvm/quarkus-app/quarkus-run.jar
```

Open http://localhost:8080. Set session name and revision, select light or dark
theme, and enter the current run's settings **before** sampling. Enter CPU as
`ActiveProcessorCount=2; no OS quota`, heap as `-Xms64m -Xmx256m`, container limit
as `none (host run)` and the exact flags/environment. These are declarations,
not verified host isolation. Settings lock after the first successful sample.

When switching, Ctrl-C in Terminal A, then run:

```sh
./demo-artifacts/native/app -Xms64m -Xmx256m -XX:ActiveProcessorCount=2 \
  -Dquarkus.http.port=8080
```

Check `/perf/info` reports two processors and the intended runtime on each
artifact. Verify these flags with the installed GraalVM version before the talk;
a flag rejection is a rehearsal failure, not a measurement. Equal heap flags do
not imply equal RSS or memory limits. For stronger control, run both as containers
on the same architecture with identical CPU quota and memory limit, and record
those limits. Keep image build/pull cost separate from local artifact build cost.

## Presenter script (5–7 minutes)

1. **0:00–1:00 / Start.** “This is the actual running process.” Show runtime,
   processors, heap and non-heap MiB. Explain that process uptime and “Uptime at
   StartupEvent” are not end-to-end startup or Kubernetes readiness. Save baseline.
2. **1:00–2:00 / Load.** Run first sample, then Run 5 more. “First in this session
   for this process; other clients may already have called it.” Read the first
   server duration, repeated median and range. Expand details for individual calls.
3. **2:00–3:00 / Switch runtime.** Save baseline and switch runtime. Keep the SPA
   open. Stop JVM, launch the prebuilt native artifact. Let the disconnected state
   and reconnection show; results survive. Record the new run's settings.
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
npx playwright install chromium
# With the app already running on 8080:
npm run test:browser
```

Browser tests use real backend requests for the presenter smoke test. Test-only
mocked responses exercise mismatches and partial failures and never enter the
live app bundle. The browser test checks a 1920×1080 viewport and writes screenshots
to ignored `test-results/`. Run backend tests through `quarkus_callTool` toolName
`devui-testing_runTests`, as required by AGENTS.md. Agent verification used dev mode
for UI and integration tests; packaged native rehearsal remains a separate check.
