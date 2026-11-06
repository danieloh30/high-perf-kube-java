# JVM versus Native Image: presenter guide

The story is **observe → compute → switch → compare → containerize → Kubernetes**.
Native Image need not win computation. This demo shows the measured outcome,
startup observations, memory, and the costs of producing each artifact separately.

## Prepare once, before presenting

Requirements: macOS/Linux, Python 3.9+, Git and GraalVM JDK 25 with native-image.
The launcher finds GraalVM via GRAALVM_HOME, a GraalVM JAVA_HOME, PATH, or SDKMAN's
current/uniquely matching JDK 25. An explicit selection is also supported:

```sh
GRAALVM_HOME="$HOME/.sdkman/candidates/java/25-graalce" ./demo.sh prepare
```

Configure registry credentials first (`QUARKUS_CONTAINER_IMAGE_USERNAME` /
`QUARKUS_CONTAINER_IMAGE_PASSWORD`, or a credential provider). By default,
`prepare` builds and pushes `quay.io/danieloh30/high-perf-java:1.0` for
`linux/amd64` using Quarkus Jib. Run from this checkout:

```sh
./demo.sh prepare       # build host pair + Jib image, push :1.0 for linux/amd64
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
profile. Host JVM/native builds suppress container-image build/push; a separate
Jib build then prepares and pushes the JVM image. Both builds use the selected
GraalVM JDK 25. The packaged JVM launch reuses that recorded Java executable.
Registry-only Jib push needs no local container runtime. For host-only preparation,
use `./demo.sh prepare --no-image`; `up` still prepares only host artifacts when needed. A container-built Linux
executable would not run directly on macOS.

## Presenter script (5–7 minutes)

Steps 1–5 are the core runtime comparison. The Jib/OpenShift/scaling chapter
adds time and depends on real cluster convergence; rehearse it separately.

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

### 6. Explain the prepared Jib image (extended chapter)

**Before the talk**, configure registry credentials using Quarkus's normal
`QUARKUS_CONTAINER_IMAGE_USERNAME` / `QUARKUS_CONTAINER_IMAGE_PASSWORD`
environment or credential provider. Do not enter credentials in the SPA or
commit them. Match the target cluster architecture:

```sh
./demo.sh prepare --image quay.io/danieloh30/high-perf-java:1.0 \
  --platform linux/amd64 --push-image
./demo.sh up
```

`prepare` builds the host JVM/native pair, then explicitly builds/pushes a **JVM
image** using `quarkus-container-image-jib` and
`quarkus.container-image.builder=jib`. The image build uses a separate source and
output directory under `demo-artifacts/images/`, preserving host demo artifacts.
It does not invoke `podman build` or `docker build`.

To build only the image later, use `./demo.sh image --image … --platform … --push`.
Use `./demo.sh prepare --no-push-image` or `./demo.sh image` to build and
load locally through Podman;
start the Podman machine first. Registry-only pushes do not need a local daemon.
Jib's dependency/application layers help incremental reuse, especially with warm
caches; do not promise a fixed build-time improvement.

**Browser:** from Compare, click **Continue to Containerize**. Show the prepared
image reference, digest, platform, build receipt and sources. A source-matched
receipt attaches to the host dashboard on its next metric poll. The UI never
executes builds or pushes. A configured tag alone is not proof it exists in Quay.

Say: “Quarkus already knows how the application is packaged. Jib turns that into
container layers without a Dockerfile. Dependencies can stay cached while the
application layer changes. We pushed this image before the talk.”

For an optional Podman functional check, build with `prepare --no-push-image` and
use the displayed `podman run` command on port 8082. This opens a separate browser
origin; it does not silently mix a container/VM measurement into host JVM/native
results. macOS Podman uses a Linux VM; cross-architecture emulation changes the
environment. A three-way performance comparison would require controlled settings
and separate environment-aware measurements, so it is outside this demo's core.

A macOS native executable cannot be packaged as a runnable Linux native image.
This chapter deliberately uses the JVM image. A future native container requires
a separately prepared Linux native executable and matching target architecture.

### 7. Deploy that existing image in OpenShift

Provision and log into your cluster before the talk. Prepare a project such as
`high-perf-java`, resource quota/capacity and any private-registry pull credentials.
Confirm the image platform matches the nodes. Paste the exact console/Topology
URL for that project into **06 Kubernetes**, along with project and Deployment name.

**Browser / Containerize:** click **Continue to Kubernetes**, then **Copy image
reference**. A successfully pushed matching receipt supplies a digest-qualified
reference; otherwise the configured tag is copied and its availability is unverified.

Click **Open OpenShift console**. In your prepared project:

1. Open Topology → Add to Project → Container Image (or +Add → Container Image).
2. Paste `quay.io/danieloh30/high-perf-java:1.0` or the copied digest reference.
   Do not paste the Quay web-page URL.
3. Choose a **Deployment**, explicitly name it `high-perf-java`, select service
   port 8080 and create a Route.
4. Configure startup/readiness probes on `/q/health/ready`, liveness on
   `/q/health/live`, and appropriate CPU/memory requests and limits.
5. Watch the pod reach Ready, open its Route, and copy the Route URL back into
   the SPA's **Deployed application Route URL** field.

Click **Check deployed app**. This makes a bounded browser GET to the Route's
readiness endpoint; it never benchmarks or talks to the Kubernetes API.
The result states its timestamp, HTTP duration and readiness. It observes one
routed response, not every replica. **Open deployed app** is the CORS-independent
fallback if the browser request cannot be made.

Images prepared by the helper allow the dashboard origins `http://localhost:8080`
and `http://127.0.0.1:8080` (or DEMO_PORT). Override with an explicit comma-separated
`DEMO_DASHBOARD_ORIGINS` before building if presenting from another origin. No
wildcard or credentials are injected. Existing images may need that CORS setting
before a local dashboard can inspect their Route. TLS, authentication and network
failures also remain explicit; they are not benchmark failures.

Console flow: [Red Hat's image deployment guide](https://developers.redhat.com/learning/learn:openshift:get-started-your-developer-sandbox/resource/resources:build-your-application-container-image).
Jib behavior: [Quarkus container-image guide](https://quarkus.io/guides/container-image#jib).

### 8. Scale out to 100, then back in

Prepare capacity and quota for 100 replicas in advance. For example, **100 pods
with requests of 100m CPU and 128Mi memory request 10 CPU cores and 12.5Gi memory**,
before other cluster overhead. These are planning examples, not configured values
or measured data in the SPA. Check your actual pod resources and scheduling.
Pre-pull images or explicitly explain cold image pulls if those are part of the story.

Return to **06 Kubernetes** and verify the project and Deployment name. The
**Scale out. Observe. Scale back.** panel shows direct controls by default.
For a terminal fallback, expand **Optional: use terminal commands instead**, use
the copy buttons, or run:

```sh
./demo.sh scale 100
./demo.sh scale 1
```

Namespace and Deployment both default to `high-perf-java`. Override either when needed:

```sh
./demo.sh scale 100 --namespace my-project --deployment my-app --timeout 600
```

The older `--replicas 100` syntax remains supported.

**Direct buttons (local dashboard only):** after deploying, use a valid local
`oc login` session (skip login if already authenticated). Checking the current
context is optional and only displays which kubeconfig context is selected. No cluster credentials go into the SPA:

```sh
oc login <cluster-api>
oc whoami
oc config current-context  # optional: displays the selected context; does not log in
./demo.sh down
./demo.sh up
# Optional target overrides before up:
# DEMO_NAMESPACE=my-project DEMO_DEPLOYMENT=my-app ./demo.sh up
```

In **06 Kubernetes → Scale out. Observe. Scale back.**, click **Check local cluster control**.
Verify the configured target, context and API server, then **Scale to 100 now** / **Scale to 1 now** and
confirm the exact change. These buttons use `quarkus-kubernetes-client` with your
local kubeconfig, not `oc` subprocesses. Only one observation runs at a time.
The target is fixed at local process launch; the form cannot grant access to another
Deployment. Match its namespace/name to enable the buttons. Restart the local
dashboard after changing kubeconfig context or credentials. Login needs permissions
to read Deployments, ReplicaSets and pods and update `deployments/scale`.

`demo.sh up` enables local control by default. To opt out, stop the local process
and start with `DEMO_CLUSTER_CONTROL=false ./demo.sh up`. Direct Java launches
still default to disabled. Controls require loopback, a same-origin request and an
ephemeral capability token that is not exported. They stay disabled inside a
Kubernetes pod, including through port-forwarding. Keep the local dashboard open
for control and use a separate Route tab to show the deployed app. A browser
request timeout does not cancel a server-side scale operation; inspect status
before retrying. Terminal commands remain the fallback.

These commands use your authenticated `oc` CLI and actually change **only the
named Deployment**. No cluster token is sent to the SPA. The default observation
timeout is 300 seconds (`--timeout` changes it). A timeout does not roll back the
desired replica count; inspect the console and deliberately scale back if needed.

Watch the console Topology/pods and the SPA's recorded trace. The observer stores
Ready/Available/updated counts, pending and terminating owned pods, resource/image
settings, timestamp and context in `demo-artifacts/scales/`. It follows pods owned
through ReplicaSets of that Deployment, and rejects concurrent template/identity
or desired-replica changes. Receipts attach to the local host dashboard as external
cluster observations; each update is timestamped, not claimed as a live cluster API.

Scale-out completes only when the controller has observed the desired generation
and the target is updated, Ready and Available with the corresponding owned pod
count. Scale-in also waits for excess owned pods to terminate. API polling is at
2-second intervals, so elapsed time includes API latency and polling granularity.
Already-at-target is recorded as no change, never as a zero-duration success.
Failures, cancellation and timeouts stay explicit and never become successes.

Say: “This is **scale request → observed convergence**, not pure runtime startup.
Scheduling, node provisioning, image pulls, probes and termination grace periods
all contribute. A Route can answer while other replicas are still pending.
Ready does not establish a throughput or latency SLO.”

Finish by scaling back to 1, exporting the session and running `./demo.sh down`.
The cluster Deployment remains under your control; local down/reset does not delete it.

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

Host execution and container images remain separate artifacts. Jib image receipts
record digest and platform; a local Podman inspection can record uncompressed
image-store bytes. Registry-only pushes leave image bytes not collected rather
than guessing compressed transfer size. The optional Kubernetes panel accepts real external
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

## Explain workload and cluster differences

In Compare, expand **Why Fibonacci and prime sieve can favor different runtimes**.
Fibonacci stresses recursive calls and integer addition with little explicit heap
allocation. The sieve allocates an array, marks elements in loops and constructs
an `ArrayList<Integer>` with boxing. Different generated code, JIT optimization,
allocation and GC behavior can favor different runtimes. If your two measured
winners differ, the SPA calls out that crossover; it does not invent a cause.
Five calls cannot establish JIT steady state. Compiler/allocation/GC profiles and
reversed-order fresh-process runs are needed to investigate causality. See
[GraalVM performance mechanisms](https://www.graalvm.org/latest/reference-manual/native-image/optimizations-and-performance/).

When `/perf/info` detects the Kubernetes service environment marker, the SPA
shows a cluster note. A CPU limit can throttle even one compute-bound request;
`ActiveProcessorCount` and CPU requests do not grant unrestricted CPU time.
Different node hardware, architecture, load, heap/GC and JIT history also matter.
The server's `duration_ns` wraps elapsed algorithm time, which includes time when
the thread is descheduled/throttled. Route, TLS and network overhead add to
browser HTTP duration, not this server timer. Actual throttling was not measured
by this demo, so inspect pod limits and CPU throttling metrics before concluding
that it caused your result. See [Kubernetes resource management](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/).

After scaling, a Route can send requests to different pods. Use a specific pod
port-forward or keep one replica for a single-process benchmark; the SPA rejects
changed process IDs rather than combining pod samples. Local and cluster results
must retain different resource/environment settings, even if both say JVM.

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

### Troubleshoot an HTTPS Route check

The Route check always uses HTTPS. Open **Open HTTPS readiness endpoint** to verify
the health URL and browser certificate trust. A browser `Failed to fetch` does not
identify whether the cause is connectivity, certificate trust or CORS. If the endpoint
works in its own tab but not from the local dashboard, allow the dashboard's exact
origin (shown in the error) in the deployed app's CORS settings. For the Jib
preparation workflow, set `DEMO_DASHBOARD_ORIGINS` before building/pushing, or set
`QUARKUS_HTTP_CORS_ENABLED=true` and `QUARKUS_HTTP_CORS_ORIGINS` on the Deployment
and roll it out. HTTPS for the Route and HTTP for a loopback dashboard do not by
themselves imply a protocol error. Timeouts and non-health/router responses are
reported separately; unavailable readiness is never recorded as a benchmark failure.
