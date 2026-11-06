# JVM versus Native Image: presenter guide

The story is **observe → compute → switch → repeat → explain the tradeoffs**.
Native Image need not win computation. This demo shows the measured outcome,
startup observations, memory, and the costs of producing each artifact separately.

## Prepare once, before presenting

Requirements: macOS/Linux, Python 3.9+, Git and GraalVM JDK 25 with native-image.
The launcher finds GraalVM via GRAALVM_HOME, a GraalVM JAVA_HOME, PATH, or SDKMAN's
current/uniquely matching JDK 25. An explicit selection is also supported:

```sh
GRAALVM_HOME="$HOME/.sdkman/candidates/java/25-graalce" ./demo.sh prepare
```

Normally, run from this checkout:

```sh
./demo.sh prepare       # build both artifacts; do this BEFORE the talk
./demo.sh costs         # inspect recorded build costs and source revision
./demo.sh up            # start the prepared JVM artifact; no dev mode
```

On the very first use, `up` also prepares missing artifacts. Preparation can take
several minutes and needs dependency downloads; do not do it on stage. JVM and
native outputs are preserved separately in timestamped `demo-artifacts/builds/`
bundles. A failed build never replaces the last complete pair. `current.json`
selects the completed bundle. Source/POM/wrapper changes invalidate the pair;
`prepare --force` rebuilds even if the source hash matches.

The script delegates packaging to the repository's Maven wrapper and native
profile, suppressing container-image build/push. Both builds use the selected
GraalVM JDK 25. The packaged JVM launch reuses that recorded Java executable.
No container runtime is needed for this host-native demo. A container-built Linux
executable would not run directly on macOS.

## Presenter script (5–7 minutes)

Use **one terminal** for the commands below and **one browser tab** at
http://localhost:8080. Keep that tab open for the entire comparison.

### 1. JVM: observe before doing work (about 1 minute)

**Terminal:** run `./demo.sh up`. Wait for “jvm ready”.

**Browser:** open the dashboard. In Session setup, give the session a name.
For a clean comparison, export any previous results, then click **Reset comparison
session** and confirm. This clears browser results, not build artifacts.

Select **01 Start**. Verify **JVM** and **Connected** in the header. Revision,
launch settings and build costs attach automatically when the app is launched
with demo.sh. Inspect the live heap/non-heap values and readiness.

Click **Save pre-load baseline**. The dashboard moves to **02 Load**.

Say: “This snapshot is before our benchmark calls. Heap is not total process RSS.
Uptime at StartupEvent is not Kubernetes readiness.”

### 2. JVM: do a little computation (about 1 minute)

**Browser / Load:** leave the workload on **Fibonacci / 40**.

Click **Run first sample** once. Wait for completion. Click **Run 5 more** once.
Wait until the status says **5/5 successful**. Point out the first computation
duration and the five-call median/range. Expand session details for individual
samples if needed. Do not run curl benchmarks concurrently.

Say: “First means first sample for this workload in this session and process.
This is computation after startup, not startup latency. Five sequential calls
are not a throughput, steady-state or p99 test.”

Optional: choose **Prime sieve / 1,000,000**, then use the same two buttons. This
adds array allocation, marking and list construction. Run it in the same order
on both runtimes. Changing the selector never runs work automatically.

Click **Save post-load and switch runtime**. The dashboard moves to **03 Switch
runtime**. This saves a second snapshot; the pre-load baseline stays unchanged.

### 3. Switch in the terminal (about 30 seconds)

**Terminal:**

```sh
./demo.sh switch
```

**Browser:** do not close or reload the tab. Watch disconnected/reconnecting,
then **Native Image** and **Connected**. The dashboard returns to **01 Start**.

Say: “The prebuilt executable has changed. Earlier results are saved under the
JVM process ID. We have not recompiled anything during the switch.”

### 4. Native: repeat exactly the same actions (about 1 minute)

**Browser / Start:** click **Save pre-load baseline** for Native Image.

**Browser / Load:** on **Fibonacci / 40**, click **Run first sample**, wait, then
**Run 5 more** and wait for **5/5 successful**. If you ran the optional prime
workload on JVM, select it and repeat those two buttons here too.

Click **Save post-load and compare**. The dashboard moves to **04 Compare**.

### 5. Explain what happened (about 1–2 minutes)

**Browser / Compare:** select **Fibonacci / 40** and the JVM/native process runs
from this rehearsal. Read **What these computation results mean**. It describes
the actual median difference and checks input/result agreement; it does not
promise a native win. Choose the prime workload if you collected it on both.

Say: “AOT and JIT optimize differently. Native often improves startup and memory
footprint; the JVM can match or beat it at computation. The selected workload and
these specific runs decide the result.”

Compare **first computation** separately from **repeated computation median**.
Browser HTTP includes queueing, network and serialization; server duration wraps
only the algorithm. Expand the insight explanation for those boundaries.

Expand **Baseline memory & recorded build costs**. Use **Memory snapshot phase**
to switch between **Pre-load baseline** and **Post-load snapshot**. Compare heap,
non-heap and OS process RSS separately. Inspect terminal launch → observed
readiness and Uptime at StartupEvent as distinct measurements. Build time,
peak build process RSS and artifact bytes attach automatically. Every collected
value includes its source/time. A missing pre-load snapshot is not filled from a
post-load one. Old v1 snapshots have unknown phase and remain legacy evidence.

Say: “The terminal launch observation includes process creation, requests and
polling (50 ms interval); it is not an exact Quarkus boot timer or Kubernetes
readiness. Memory is a point observation, not a leak or peak-usage test.”

Check any resource-setting warnings. Equal Xmx is not equal RSS or an OS memory
limit. A dirty build is flagged because commit revision alone is insufficient.

### 6. Optional Kubernetes story and finish (about 30 seconds)

Click **Continue to Kubernetes**. If this is a host-only rehearsal, explain why
container/image metrics are not applicable or not collected. If you imported
external pod observations, show their source and measurement boundaries.

Say: “Scheduling, image pull, process start, readiness and load performance are
separate milestones. Ready does not prove a throughput or latency SLO.”

Export the session from Session setup. **Terminal:** `./demo.sh down`.

## Stop, reset, or start another comparison

```sh
./demo.sh down           # stop managed process; KEEP builds, costs and logs
./demo.sh up             # reuse prepared artifacts and start JVM
./demo.sh switch native  # choose native explicitly; no build
./demo.sh switch jvm     # choose JVM explicitly; no build
./demo.sh status         # PID, health and exact launch settings
./demo.sh logs           # last launch log, including failed launches
./demo.sh reset          # stop managed process; DELETE demo-artifacts contents and target/
```

`reset` preserves repository sources and the command-lock file. Export any
comparison you need before using it: after the next `up`, the dashboard detects
the terminal reset and automatically clears old JVM/native runs, samples and
snapshots. It returns to Start with only the currently running process. Normal
runtime switches and `prepare --force` preserve the comparison.

Reset refuses to delete artifacts while this checkout's dev mode is running and
refuses to kill an unowned PID. Stop dev mode with `quarkus_stop` first. After
reset, the next `up` rebuilds both artifacts; do this before the next talk.

For a full clean rehearsal:

```sh
./demo.sh reset
./demo.sh prepare
./demo.sh up
```

Keep the browser open and wait for reconnection; its old native comparison is
cleared automatically. While the backend is offline, saved observations can
remain visible until the new process communicates the reset. A disconnected
saved Native run does not mean a native process is running.

**Reset comparison session** in the browser is still available for clearing
results without rebuilding. It keeps your theme and the current process, so a
currently running native process will reconnect as Native. Use `down` then `up`
for a fresh JVM process. Explicitly imported sessions are retained until the next
terminal reset, so you can review a prior exported comparison deliberately.

Defaults for both processes are `-Xms64m -Xmx256m -XX:ActiveProcessorCount=2`,
port 8080 and loopback HTTP binding. Override before up, with no process running:

```sh
DEMO_PORT=8080 DEMO_CPUS=2 DEMO_XMS=64m DEMO_XMX=256m ./demo.sh up
```

Switch preserves these launch settings. They declare heap/processor settings,
not host CPU affinity, quotas or isolation. Host activity, JIT history, GC, cache
state, order and thermal conditions still differ in sequential local runs.
Repeat in reverse order on fresh processes when investigating results.

## What is collected, and what requires an external environment

The app reads only the launcher's configured evidence file and requires its
process ID to match. No browser-accessible shell or process-control API exists.
Build wall time, artifact byte counts, build-process RSS when host time supports
it, launch settings, revision and launch-to-observed-readiness attach without
manual copying. RSS uses Linux /proc or macOS ps, outside benchmark timing.

Container usage is collected only from an identified process container's readable
memory cgroup. It includes that group's processes, not just this JVM. On a host
launch it is not applicable. Unsupported or inaccessible sources remain explicit.
Non-heap values unsupported by a runtime remain unavailable. Maximum RSS reported
by host time is not an aggregate concurrent container/build-memory peak.

This launcher produces executables, not container images, so image bytes are not
applicable to its host run. The optional Kubernetes panel accepts real external
image bytes, requests/limits, scheduling, image-pull, process-start, readiness and
under-load observations with source and timestamp. Missing observations remain
not collected; no examples or fixture measurements are loaded into live sessions.

## Optional Kubernetes collection (separate from the app)

Deploy actual JVM/native images with matching requests/limits and probes first.
Replace namespace and pod below. Keep image digest, architecture, clock assumptions
and whether image bytes are compressed/uncompressed with the observations.

```sh
kubectl -n demo get pod POD -o json > pod.json
kubectl -n demo get events --field-selector involvedObject.name=POD -o json > events.json
kubectl -n demo logs POD --timestamps > process.log
kubectl -n demo get pod POD -o jsonpath='{.spec.containers[*].resources}'
kubectl -n demo wait --for=condition=Ready pod/POD --timeout=120s
```

Wait duration begins at command invocation, not pod creation. Use pod scheduling
and Ready conditions, container startedAt and image-pull events. Events may be
missing/coarse. Import an observation object in Session setup with `runtime`
(`jvm` or `native-image`), `source`, ISO `timestamp` and optional `image_bytes`,
`requests`, `limits`, `scheduling`, `image_pull`, `process_start`, `readiness`,
`under_load`. State units and start/end boundaries. Collect SLO evidence with a
separately specified load test; never derive it from Ready.

## Curl fallback

```sh
curl -fsS http://localhost:8080/perf/info
curl -fsS http://localhost:8080/q/health/ready
curl -fsS 'http://localhost:8080/perf/fib?n=40'
for i in 1 2 3 4 5; do curl -fsS 'http://localhost:8080/perf/fib?n=40'; printf '\n'; done
curl -fsS 'http://localhost:8080/perf/primes?limit=1000000'
curl -fsS http://localhost:8080/q/metrics
```

## If button names do not match this guide

The current buttons are **Save pre-load baseline**, **Save post-load and switch
runtime** (JVM), and **Save post-load and compare** (after collecting the other
runtime). If you see “Save baseline and switch runtime”, the tab has an older
JavaScript version. Older artifacts served assets as immutable for one day.

Hard-refresh once (macOS: Cmd+Shift+R; Windows/Linux: Ctrl+Shift+R). This keeps
localStorage results. The fixed build serves presenter assets with no-store and
versioned URLs. Restarting an old prepared artifact does not update its files:
stop it and run `./demo.sh prepare`, then `./demo.sh up`, before hard-refreshing.
Do not reset artifacts or browser results just to refresh the UI. Existing v1
samples migrate and can produce insights immediately when both runs have the
selected workload. Current-process evidence attaches on the next successful
poll. An older saved process may still lack snapshots or evidence that its old
frontend never saved; those observations cannot be invented retroactively.
Export those results before starting a fresh comparison if you need to keep them.

## Verification

```sh
npm ci
npm test
python3 -m unittest discover -s tests -p test_demo.py
npx playwright install chromium
# App already running; use DEMO_TEST_URL=http://localhost:8081 if appropriate:
npm run test:browser
npm run test:cache       # regression with old modules already in browser cache
```

Run backend tests through Quarkus MCP `devui-testing_runTests`, following AGENTS.md.
Browser tests inspect 1920×1080 screens and real requests; additional test-only
fixtures exercise failures and switches. Launcher fixtures live in temporary
directories and never become live demo artifacts. Real packaged/native rehearsal
is separate: AGENTS.md prohibits the agent from running Maven manually and Dev MCP
exposes no packaging operation. The presenter can execute demo.sh directly.
