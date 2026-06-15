package org.acme;

import io.quarkus.test.junit.QuarkusTest;
import org.junit.jupiter.api.Test;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.*;

/**
 * Tests for the performance demo endpoints.
 */
@QuarkusTest
class PerformanceResourceTest {

    // ── /perf/info ────────────────────────────────────────────────────────────

    @Test
    void testPerfInfo() {
        given()
            .when().get("/perf/info")
            .then()
            .statusCode(200)
            .contentType("application/json")
            .body("runtime_type",          notNullValue())
            .body("java_version",          notNullValue())
            .body("uptime_ms",             greaterThanOrEqualTo(0))
            .body("heap_used_mb",          greaterThan(0.0f))
            .body("available_processors",  greaterThanOrEqualTo(1));
    }

    // ── /perf/fib ─────────────────────────────────────────────────────────────

    @Test
    void testFibDefault() {
        given()
            .when().get("/perf/fib")
            .then()
            .statusCode(200)
            .body("input_n",     is(40))
            .body("result",      is(102334155))      // fib(40) = 102334155 (JSON int)
            .body("duration_ms", greaterThanOrEqualTo(0));
    }

    @Test
    void testFibCustomN() {
        given()
            .queryParam("n", 10)
            .when().get("/perf/fib")
            .then()
            .statusCode(200)
            .body("input_n", is(10))
            .body("result",  is(55));                // fib(10) = 55 (JSON int)
    }

    @Test
    void testFibClampsTooLarge() {
        // n > 45 is clamped to 40 to avoid impractical runtimes
        given()
            .queryParam("n", 99)
            .when().get("/perf/fib")
            .then()
            .statusCode(200)
            .body("input_n", is(40));
    }

    // ── /perf/primes ──────────────────────────────────────────────────────────

    @Test
    void testPrimesDefault() {
        given()
            .when().get("/perf/primes")
            .then()
            .statusCode(200)
            .body("limit",         is(1_000_000))
            .body("prime_count",   is(78498))          // π(1_000_000) = 78498
            .body("largest_prime", is(999983))
            .body("duration_ms",   greaterThanOrEqualTo(0));
    }

    @Test
    void testPrimesCustomLimit() {
        given()
            .queryParam("limit", 100)
            .when().get("/perf/primes")
            .then()
            .statusCode(200)
            .body("limit",       is(100))
            .body("prime_count", is(25));              // 25 primes ≤ 100
    }
}
