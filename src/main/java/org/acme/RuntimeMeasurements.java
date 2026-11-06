package org.acme;

import jakarta.enterprise.context.ApplicationScoped;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/** OS observations collected outside benchmark timing boundaries. */
@ApplicationScoped
public class RuntimeMeasurements {
    public Map<String, Object> rss() {
        String timestamp = Instant.now().toString();
        try {
            Path status = Path.of("/proc/self/status");
            if (Files.isReadable(status)) {
                for (String line : Files.readAllLines(status)) {
                    if (line.startsWith("VmRSS:"))
                        return measured(Long.parseLong(line.trim().split("\\s+")[1]) / 1024.0,
                                "/proc/self/status VmRSS (KiB / 1024)", timestamp);
                }
            }
            if (System.getProperty("os.name", "").toLowerCase().contains("mac")) {
                Process ps = new ProcessBuilder("/bin/ps", "-o", "rss=", "-p",
                        Long.toString(ProcessHandle.current().pid())).start();
                if (!ps.waitFor(1, TimeUnit.SECONDS)) {
                    ps.destroyForcibly();
                } else if (ps.exitValue() == 0) {
                    long kib = Long.parseLong(new String(ps.getInputStream().readAllBytes()).trim());
                    return measured(kib / 1024.0, "ps RSS (KiB / 1024), current process", timestamp);
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception ignored) {
            // Missing OS facilities are unavailable, never zero-duration or zero-memory successes.
        }
        return Map.of("status", "not-collected", "reason", "Process RSS is unavailable on this host.", "timestamp", timestamp);
    }

    static Map<String, Object> measured(double mib, String source, String timestamp) {
        if (!Double.isFinite(mib) || mib < 0)
            return Map.of("status", "not-collected", "reason", "Invalid OS measurement.");
        return Map.of("status", "collected", "value_mib", mib, "source", source, "timestamp", timestamp);
    }

    public Map<String, Object> container() {
        if (!System.getProperty("os.name", "").toLowerCase().contains("linux"))
            return Map.of("status", "not-applicable", "reason", "Host process; no Linux container cgroup.");
        try {
            String memberships = Files.readString(Path.of("/proc/self/cgroup"));
            boolean container = Files.exists(Path.of("/.dockerenv")) || Files.exists(Path.of("/run/.containerenv"))
                    || System.getenv("KUBERNETES_SERVICE_HOST") != null
                    || memberships.matches("(?s).*(docker|kubepods|containerd|libpod).*" );
            if (!container)
                return Map.of("status", "not-collected", "reason", "No container identified; host cgroup memory is not container usage.");
            for (String line : memberships.lines().toList()) {
                String[] parts = line.split(":", 3);
                if (parts.length != 3) continue;
                boolean v2 = parts[0].equals("0") && parts[1].isEmpty();
                boolean v1 = java.util.Arrays.asList(parts[1].split(",")).contains("memory");
                if (!v2 && !v1) continue;
                Path root = Path.of(v2 ? "/sys/fs/cgroup" : "/sys/fs/cgroup/memory");
                Path group = root.resolve(parts[2].replaceFirst("^/+", "")).normalize();
                if (!group.startsWith(root)) continue;
                Path usage = group.resolve(v2 ? "memory.current" : "memory.usage_in_bytes");
                long bytes = Long.parseLong(Files.readString(usage).trim());
                return measured(bytes / 1_048_576.0, usage + " (cgroup usage, may include other processes)", Instant.now().toString());
            }
        } catch (Exception ignored) {}
        return Map.of("status", "not-collected", "reason", "Container identified, but its memory cgroup could not be resolved.");
    }
}
