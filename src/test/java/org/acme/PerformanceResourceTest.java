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
            .body("runtime_type",          isOneOf("jvm", "native-image"))
            .body("process_id", not(emptyString()))
            .body("process_start_epoch_ms", greaterThan(0L))
            .body("java_version",          notNullValue())
            .body("uptime_ms",             greaterThanOrEqualTo(0))
            .body("heap_used_mb",          greaterThan(0.0f))
            .body("available_processors",  greaterThanOrEqualTo(1))
            .body("process_rss.status", isOneOf("collected", "not-collected"))
            .body("container_memory.status", isOneOf("collected", "not-collected", "not-applicable"))
            .body("demo_evidence.status", is("not-collected"));
    }

    @Test
    void processIdentityMatchesAcrossEndpoints() {
        String id = given().get("/perf/info").then().statusCode(200)
                .extract().path("process_id");
        given().get("/perf/info").then().body("process_id", is(id));
        given().queryParam("n", 10).get("/perf/fib").then().body("process_id", is(id));
        given().queryParam("limit", 100).get("/perf/primes").then().body("process_id", is(id));
    }

    @Test
    void presenterAssetsAreServedLocally() {
        given().get("/").then().statusCode(200).body(containsString("presenter.mjs"));
        given().get("/session.mjs").then().statusCode(200).body(containsString("runtime-lab.session.v2"));
        given().get("/presenter.css").then().statusCode(200).body(containsString("data-theme=\"light\""));
    }

    @Test
    void presenterAssetsMustNotRemainCachedBetweenPreparedArtifacts() {
        for (String path : new String[]{"/", "/index.html", "/presenter.css?v=20261106-3",
                "/presenter.mjs?v=20261106-3", "/session.mjs?v=20261106-3"}) {
            given().get(path).then().statusCode(200).header("Cache-Control", containsString("no-store"));
        }
        given().get("/").then().body(containsString("presenter.mjs?v=20261106-3"));
        given().get("/presenter.mjs?v=20261106-3").then()
            .body(containsString("session.mjs?v=20261106-3"))
            .body(containsString("Save post-load and switch runtime"))
            .body(containsString("Save post-load and compare"));
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
            .body("duration_ms", greaterThanOrEqualTo(0))
            .body("duration_ns.toLong()", greaterThan(0L))
            .body("process_id", not(emptyString()));
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
