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
             .body(is("Hello from Quarkus Java"));
    }

    @Test
    void testHelloNameEndpoint() {
        given()
                .when().get("/hello/name")
                .then()
                .statusCode(200)
                .body(is("Welcome Everyone at the Red Hat Summit 2026!!!"));
    }

}
