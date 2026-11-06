package org.acme;

import io.quarkus.test.junit.QuarkusTest;
import io.quarkus.test.junit.QuarkusTestProfile;
import io.quarkus.test.junit.TestProfile;
import org.junit.jupiter.api.Test;
import java.util.Map;
import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.*;

@QuarkusTest
@TestProfile(ClusterControlEnabledTest.EnabledProfile.class)
class ClusterControlEnabledTest {
    public static class EnabledProfile implements QuarkusTestProfile {
        @Override public Map<String,String> getConfigOverrides() { return Map.of("demo.cluster-control.enabled","true"); }
    }
    @Test void optedInControlStillRequiresTokenLocalOriginAndFixedTargets() {
        String token=given().get("/demo/cluster-control").then().statusCode(200).body("enabled",is(true)).extract().path("token");
        given().contentType("application/json").body("{\"replicas\":100}").post("/demo/cluster-control/scale").then().statusCode(403);
        given().contentType("application/json").header("X-Demo-Control",token).body("{\"replicas\":2}").post("/demo/cluster-control/scale").then().statusCode(400);
        given().contentType("application/json").header("Origin","https://attacker.example").header("X-Demo-Control",token).body("{\"replicas\":100}").post("/demo/cluster-control/scale").then().statusCode(403);
        given().header("Origin","https://attacker.example").get("/demo/cluster-control").then().body("enabled",is(false)).body("token",nullValue());
    }
}
