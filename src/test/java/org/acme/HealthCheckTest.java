package org.acme;

import io.quarkus.test.junit.QuarkusTest;
import org.junit.jupiter.api.Test;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.*;

/**
 * Tests for health checks exposed via SmallRye Health.
 */
@QuarkusTest
class HealthCheckTest {

    @Test
    void testOverallHealthIsUp() {
        given()
            .when().get("/q/health")
            .then()
            .statusCode(200)
            .body("status", is("UP"));
    }

    @Test
    void testLivenessIsUp() {
        given()
            .when().get("/q/health/live")
            .then()
            .statusCode(200)
            .body("status", is("UP"))
            .body("checks.find { it.name == 'jvm-liveness' }.status", is("UP"))
            .body("checks.find { it.name == 'jvm-liveness' }.data.runtime", notNullValue())
            .body("checks.find { it.name == 'jvm-liveness' }.data.heap_used_mb", greaterThan(0));
    }

    @Test
    void testReadinessIsUp() {
        given()
            .when().get("/q/health/ready")
            .then()
            .statusCode(200)
            .body("status", is("UP"))
            .body("checks.find { it.name == 'app-readiness' }.status", is("UP"))
            .body("checks.find { it.name == 'app-readiness' }.data.startup_time_ms", greaterThan(0));
    }
}
