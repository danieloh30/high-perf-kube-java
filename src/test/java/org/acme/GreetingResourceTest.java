package org.acme;

import io.quarkus.test.junit.QuarkusTest;
import org.junit.jupiter.api.Test;

import static io.restassured.RestAssured.given;
import static org.hamcrest.CoreMatchers.is;

@QuarkusTest
class GreetingResourceTest {
    @Test
    void testHelloEndpoint() {
        given()
          .when().get("/hello")
          .then()
             .statusCode(200)
             .body(is("Hello Java Developers!"));
    }

    @Test
    void testHelloNameEndpoint() {
        given()
                .when().get("/hello/perf")
                .then()
                .statusCode(200)
                .body(is("High Performance Kube Native Java with Quarkus"));
    }

}
