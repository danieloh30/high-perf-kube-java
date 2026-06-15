package org.acme;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import jakarta.inject.Inject;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.core.MediaType;

import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.RuntimeMXBean;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Performance demonstration endpoints for KubeCon India 2026.
 *
 * <p>Showcases: startup speed, memory footprint, JVM stats, and
 * compute-bound benchmark tasks (Fibonacci / prime sieve) that
 * audience members can run side-by-side in JVM mode vs Native Image.</p>
 */
@Path("/perf")
public class PerformanceResource {

    @Inject
    MeterRegistry registry;

    // ---------------------------------------------------------------
    // JVM / runtime stats
    // ---------------------------------------------------------------

    @GET
    @Path("/info")
    @Produces(MediaType.APPLICATION_JSON)
    public Map<String, Object> runtimeInfo() {
        RuntimeMXBean runtime = ManagementFactory.getRuntimeMXBean();
        MemoryMXBean memory = ManagementFactory.getMemoryMXBean();

        boolean isNative = System.getProperty("org.graalvm.nativeimage.imagecode") != null
                || System.getProperty("java.vm.name", "").contains("Substrate");

        Map<String, Object> info = new HashMap<>();
        info.put("runtime_type", isNative ? "native-image" : "jvm");
        info.put("java_version", System.getProperty("java.version", "unknown"));
        info.put("vm_name", System.getProperty("java.vm.name", "unknown"));
        info.put("vm_vendor", System.getProperty("java.vm.vendor", "unknown"));
        info.put("uptime_ms", runtime.getUptime());
        info.put("uptime_human", formatDuration(runtime.getUptime()));
        info.put("heap_used_mb", toMb(memory.getHeapMemoryUsage().getUsed()));
        info.put("heap_max_mb", toMb(memory.getHeapMemoryUsage().getMax()));
        info.put("heap_committed_mb", toMb(memory.getHeapMemoryUsage().getCommitted()));
        info.put("non_heap_used_mb", toMb(memory.getNonHeapMemoryUsage().getUsed()));
        info.put("available_processors", Runtime.getRuntime().availableProcessors());
        return info;
    }

    // ---------------------------------------------------------------
    // Compute benchmark: Fibonacci (recursive, naïve — intentionally slow)
    // ---------------------------------------------------------------

    @GET
    @Path("/fib")
    @Produces(MediaType.APPLICATION_JSON)
    public Map<String, Object> fibonacci(@QueryParam("n") Integer n) {
        int input = (n == null || n < 1 || n > 45) ? 40 : n;

        long start = System.nanoTime();
        long fibResult = fib(input);
        long durationNs = System.nanoTime() - start;

        // Record timing in Micrometer (visible in /q/metrics)
        Timer.builder("demo.benchmark")
                .tag("type", "fibonacci")
                .description("Recursive Fibonacci benchmark")
                .register(registry)
                .record(durationNs, TimeUnit.NANOSECONDS);

        Map<String, Object> res = new HashMap<>();
        res.put("input_n", input);
        res.put("result", fibResult);
        res.put("duration_ms", TimeUnit.NANOSECONDS.toMillis(durationNs));
        res.put("duration_ns", durationNs);
        return res;
    }

    // ---------------------------------------------------------------
    // Compute benchmark: Sieve of Eratosthenes
    // ---------------------------------------------------------------

    @GET
    @Path("/primes")
    @Produces(MediaType.APPLICATION_JSON)
    public Map<String, Object> primes(@QueryParam("limit") Integer limit) {
        int cap = (limit == null || limit < 100 || limit > 10_000_000) ? 1_000_000 : limit;

        long start = System.nanoTime();
        List<Integer> primeList = sieve(cap);
        long durationNs = System.nanoTime() - start;

        // Record timing in Micrometer (visible in /q/metrics)
        Timer.builder("demo.benchmark")
                .tag("type", "prime-sieve")
                .description("Sieve of Eratosthenes benchmark")
                .register(registry)
                .record(durationNs, TimeUnit.NANOSECONDS);

        // Count total calls for the counter gauge shown on the dashboard
        Counter.builder("demo.primes.calls")
                .description("Total prime sieve calls")
                .register(registry)
                .increment();

        Map<String, Object> res = new HashMap<>();
        res.put("limit", cap);
        res.put("prime_count", primeList.size());
        res.put("largest_prime", primeList.isEmpty() ? 0 : primeList.getLast());
        res.put("duration_ms", TimeUnit.NANOSECONDS.toMillis(durationNs));
        res.put("duration_ns", durationNs);
        return res;
    }

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------

    private static long fib(int n) {
        if (n <= 1) return n;
        return fib(n - 1) + fib(n - 2);
    }

    private static List<Integer> sieve(int limit) {
        boolean[] composite = new boolean[limit + 1];
        List<Integer> primes = new ArrayList<>();
        for (int i = 2; i <= limit; i++) {
            if (!composite[i]) {
                primes.add(i);
                for (long j = (long) i * i; j <= limit; j += i) {
                    composite[(int) j] = true;
                }
            }
        }
        return primes;
    }

    private static double toMb(long bytes) {
        return Math.round((bytes / 1_048_576.0) * 100.0) / 100.0;
    }

    private static String formatDuration(long ms) {
        Duration d = Duration.ofMillis(ms);
        if (d.toMinutes() > 0) return d.toMinutes() + "m " + d.toSecondsPart() + "s";
        if (d.toSeconds() > 0) return d.toSeconds() + "s";
        return ms + "ms";
    }
}
