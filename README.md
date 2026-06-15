# ⚡ High Performance Kube Native Java

A **KubeCon India 2026** performance demo that showcases the difference between
running a Quarkus application as a standard JVM app versus a **GraalVM Native Image**
— with live, browser-visible metrics.

Built with **[Quarkus 3.x](https://quarkus.io)** · Java 25 · Micrometer · SmallRye Health

---

## 🚀 Quick Start

```shell
./mvnw quarkus:dev          # JVM mode  – open http://localhost:8080
```

For the full native-image demo (requires GraalVM or container build):

```shell
# Build native (GraalVM locally)
./mvnw package -Dnative

# Build native inside a container (no local GraalVM needed)
./mvnw package -Dnative -Dquarkus.native.container-build=true

# Run native
./target/high-perf-kube-java-1.0.0-SNAPSHOT-runner
```

---

## 🖥️ Performance Dashboard

Open **[http://localhost:8080](http://localhost:8080)** in a browser.

The dashboard shows — live, auto-refreshing:

| Panel | What you see |
|---|---|
| **Runtime Type** | `JVM` or `Native Image` badge |
| **Uptime** | Seconds since start (dramatic in native mode!) |
| **Heap Used / Max** | Colour-coded bar chart |
| **Non-Heap** | Loaded classes + JIT-compiled code size |
| **CPU Cores** | Available processors |
| **Java Version** | Runtime version & vendor |
| **Health Checks** | Live liveness + readiness status with JVM data |
| **Fibonacci Benchmark** | Naïve recursive fib(n) — drag a slider, click Run |
| **Prime Sieve Benchmark** | Sieve of Eratosthenes up to N — shows prime count & largest prime |
| **History Table** | Timestamped results with ×-faster comparisons between runs |

---

## 📡 API Endpoints

### Greeting

| Method | Path | Description |
|---|---|---|
| `GET` | `/hello` | Basic greeting |
| `GET` | `/hello/perf` | Performance tagline |
| `GET` | `/hello/runtime` | JVM vs Native Image detection string |

### Performance

| Method | Path | Query params | Description |
|---|---|---|---|
| `GET` | `/perf/info` | – | JSON: uptime, heap, non-heap, java version, runtime type |
| `GET` | `/perf/fib` | `n` (1–45, default 40) | Naïve recursive Fibonacci — great for comparing JVM/native compute speed |
| `GET` | `/perf/primes` | `limit` (100–10 000 000, default 1 000 000) | Sieve of Eratosthenes — memory + CPU bound |

### Observability

| Path | Description |
|---|---|
| `/q/health` | Combined health (liveness + readiness) |
| `/q/health/live` | Liveness — includes heap stats |
| `/q/health/ready` | Readiness — includes measured startup time |
| `/q/metrics` | Prometheus scrape endpoint |
| `/q/dev/` | Quarkus Dev UI (dev mode only) |

---

## 🎯 Demo Flow (KubeCon)

1. **Start in JVM mode** → open dashboard → note uptime (~1 s) and heap (~60 MB)
2. **Run fib(40)** — via the dashboard slider, or directly from the terminal:

   ```shell
   # Default n=40
   curl http://localhost:8080/perf/fib

   # Custom n (1–45)
   curl "http://localhost:8080/perf/fib?n=42"
   ```

   Example response:
   ```json
   {
     "input_n": 40,
     "result": 102334155,
     "duration_ms": 712,
     "duration_ns": 712345678
   }
   ```

3. **Run Sieve(1 000 000)** — via the dashboard input, or from the terminal:

   ```shell
   # Default limit=1_000_000
   curl http://localhost:8080/perf/primes

   # Custom limit (100–10_000_000)
   curl "http://localhost:8080/perf/primes?limit=5000000"
   ```

   Example response:
   ```json
   {
     "limit": 1000000,
     "prime_count": 78498,
     "largest_prime": 999983,
     "duration_ms": 28,
     "duration_ns": 28341567
   }
   ```

4. **Stop, rebuild as native, restart** → same dashboard URL
5. Notice the uptime badge is now `< 50 ms` — and the heap is a fraction of the JVM
6. **Re-run the exact same curl commands** → compare duration_ms side-by-side:

   ```shell
   # Quick side-by-side loop — run on both JVM and native, paste results into the history table
   for i in 1 2 3; do
     curl -s http://localhost:8080/perf/fib | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'fib({d[\"input_n\"]}) = {d[\"result\"]}  [{d[\"duration_ms\"]} ms]')"
   done
   ```

7. History table in the dashboard shows **×-faster** comparisons automatically between runs
8. Open `/q/health/ready` — startup time is embedded in the JSON:

   ```shell
   curl -s http://localhost:8080/q/health/ready | python3 -m json.tool
   ```

   ```json
   {
     "status": "UP",
     "checks": [
       {
         "name": "app-readiness",
         "status": "UP",
         "data": {
           "startup_time_ms": 47,
           "startup_human": "47 ms"
         }
       }
     ]
   }
   ```

### Example Output Comparison

```json
// JVM  /perf/info
{ "runtime_type": "jvm", "uptime_human": "2s", "heap_used_mb": 62.4 }

// Native  /perf/info
{ "runtime_type": "native-image", "uptime_human": "48ms", "heap_used_mb": 8.1 }
```

### Full curl cheat-sheet

```shell
# Runtime info
curl -s http://localhost:8080/perf/info | python3 -m json.tool

# Fibonacci — adjust n (max 45)
curl -s "http://localhost:8080/perf/fib?n=40"
curl -s "http://localhost:8080/perf/fib?n=45"   # slowest allowed value

# Prime sieve — adjust limit
curl -s "http://localhost:8080/perf/primes?limit=1000000"
curl -s "http://localhost:8080/perf/primes?limit=5000000"

# Health endpoints
curl -s http://localhost:8080/q/health
curl -s http://localhost:8080/q/health/live
curl -s http://localhost:8080/q/health/ready

# Prometheus metrics (grep for demo-specific ones)
curl -s http://localhost:8080/q/metrics | grep demo_benchmark
curl -s http://localhost:8080/q/metrics | grep jvm_memory
```

---

## 🏗️ New Extensions Added

| Extension | Purpose |
|---|---|
| `quarkus-rest-jackson` | JSON serialisation for performance endpoints |
| `quarkus-smallrye-health` | `/q/health` liveness + readiness checks |
| `quarkus-micrometer-registry-prometheus` | `/q/metrics` Prometheus scrape + JVM gauges |

---

## 📦 Packaging

### JVM JAR

```shell
./mvnw package
java -jar target/quarkus-app/quarkus-run.jar
```

### Über-JAR

```shell
./mvnw package -Dquarkus.package.jar.type=uber-jar
java -jar target/*-runner.jar
```

### Native Image

```shell
./mvnw package -Dnative
./target/high-perf-kube-java-1.0.0-SNAPSHOT-runner
```

### Container Image (Jib)

Uncomment the `quarkus.container-image.*` lines in
[`src/main/resources/application.properties`](src/main/resources/application.properties), then:

```shell
./mvnw package -Dquarkus.container-image.build=true
```

---

## 🧪 Tests

```shell
./mvnw test            # unit + integration tests (12 tests)
./mvnw test -Dnative   # native integration tests
```

Test classes:

| Class | Coverage |
|---|---|
| [`GreetingResourceTest`](src/test/java/org/acme/GreetingResourceTest.java) | `/hello`, `/hello/perf`, `/hello/runtime` |
| [`PerformanceResourceTest`](src/test/java/org/acme/PerformanceResourceTest.java) | `/perf/info`, `/perf/fib`, `/perf/primes` |
| [`HealthCheckTest`](src/test/java/org/acme/HealthCheckTest.java) | `/q/health`, `/q/health/live`, `/q/health/ready` |

---

## Related Guides

- [Quarkus REST](https://quarkus.io/guides/rest)
- [SmallRye Health](https://quarkus.io/guides/smallrye-health)
- [Micrometer Metrics](https://quarkus.io/guides/micrometer)
- [Building a Native Executable](https://quarkus.io/guides/building-native-image)
- [Container Images with Jib](https://quarkus.io/guides/container-image#jib)
