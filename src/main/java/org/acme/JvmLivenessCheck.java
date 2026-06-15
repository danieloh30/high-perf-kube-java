package org.acme;

import jakarta.enterprise.context.ApplicationScoped;
import org.eclipse.microprofile.health.HealthCheck;
import org.eclipse.microprofile.health.HealthCheckResponse;
import org.eclipse.microprofile.health.Liveness;

import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;

/**
 * Liveness check that also surfaces heap usage so the Kubernetes
 * dashboard (and the demo audience) can see real-time memory data.
 */
@Liveness
@ApplicationScoped
public class JvmLivenessCheck implements HealthCheck {

    @Override
    public HealthCheckResponse call() {
        MemoryMXBean memory = ManagementFactory.getMemoryMXBean();
        long usedMb  = memory.getHeapMemoryUsage().getUsed()  / 1_048_576;
        long maxMb   = memory.getHeapMemoryUsage().getMax()   / 1_048_576;

        boolean isNative = System.getProperty("org.graalvm.nativeimage.imagecode") != null
                || System.getProperty("java.vm.name", "").contains("Substrate");

        return HealthCheckResponse
                .named("jvm-liveness")
                .up()
                .withData("runtime", isNative ? "native-image" : "jvm")
                .withData("heap_used_mb", usedMb)
                .withData("heap_max_mb", maxMb)
                .withData("java_version", System.getProperty("java.version", "unknown"))
                .build();
    }
}
