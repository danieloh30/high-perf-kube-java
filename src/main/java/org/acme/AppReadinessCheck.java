package org.acme;

import io.quarkus.runtime.StartupEvent;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;
import org.eclipse.microprofile.health.HealthCheck;
import org.eclipse.microprofile.health.HealthCheckResponse;
import org.eclipse.microprofile.health.Readiness;

import java.lang.management.ManagementFactory;

/** Records process uptime at StartupEvent, not Kubernetes or end-to-end readiness. */
@Readiness
@ApplicationScoped
public class AppReadinessCheck implements HealthCheck {

    private volatile long startupMs = -1;
    private volatile String processId;

    public String processId() { return processId; }

    void onStart(@Observes StartupEvent event) {
        processId = java.util.UUID.randomUUID().toString();
        startupMs = ManagementFactory.getRuntimeMXBean().getUptime();
    }

    @Override
    public HealthCheckResponse call() {
        return HealthCheckResponse
                .named("app-readiness")
                .up()
                .withData("process_id", processId)
                .withData("startup_time_ms", startupMs)
                .withData("startup_human", startupMs < 0 ? "initialising" : startupMs + " ms")
                .build();
    }
}
