package org.acme;

import io.quarkus.runtime.StartupEvent;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;
import org.eclipse.microprofile.health.HealthCheck;
import org.eclipse.microprofile.health.HealthCheckResponse;
import org.eclipse.microprofile.health.Readiness;

import java.lang.management.ManagementFactory;

/**
 * Readiness check that records the actual application startup time.
 * In the demo this makes the JVM vs Native Image startup gap visible
 * directly from the Kubernetes health endpoint.
 */
@Readiness
@ApplicationScoped
public class AppReadinessCheck implements HealthCheck {

    private volatile long startupMs = -1;

    void onStart(@Observes StartupEvent event) {
        startupMs = ManagementFactory.getRuntimeMXBean().getUptime();
    }

    @Override
    public HealthCheckResponse call() {
        return HealthCheckResponse
                .named("app-readiness")
                .up()
                .withData("startup_time_ms", startupMs)
                .withData("startup_human", startupMs < 0 ? "initialising" : startupMs + " ms")
                .build();
    }
}
