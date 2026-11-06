package org.acme;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import io.fabric8.kubernetes.client.ConfigBuilder;
import io.fabric8.kubernetes.client.KubernetesClientBuilder;
import io.quarkus.test.junit.QuarkusTest;
import org.junit.jupiter.api.Test;
import java.net.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.*;
import static org.junit.jupiter.api.Assertions.*;

@QuarkusTest
class ClusterControlResourceTest {
    @Test void controlIsDisabledByDefaultAndCannotExecuteCommands() {
        given().get("/demo/cluster-control").then().statusCode(200).body("enabled",is(false)).body("token",nullValue());
        given().contentType("application/json").body("{\"replicas\":100}").post("/demo/cluster-control/scale").then().statusCode(403);
    }
    @Test void localGuardRejectsRemoteDnsRebindingAndCrossOriginRequests() {
        URI local=URI.create("http://localhost:8080/");
        assertTrue(ClusterControlResource.localRequest("127.0.0.1",local,"http://localhost:8080","same-origin"));
        assertFalse(ClusterControlResource.localRequest("10.0.0.1",local,null,null));
        assertFalse(ClusterControlResource.localRequest("127.0.0.1",URI.create("http://attacker.example:8080/"),null,null));
        assertFalse(ClusterControlResource.localRequest("127.0.0.1",local,"https://attacker.example","cross-site"));
        assertFalse(ClusterControlResource.localRequest("127.0.0.1",local,"http://localhost:9090","same-site"));
    }
    @Test void realClientAgainstTestOnlyApiRecordsScaleOutInAndFailureWithoutInventingTiming() throws Exception {
        HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        ObjectMapper json=new ObjectMapper();
        AtomicInteger desired=new AtomicInteger(1), writes=new AtomicInteger();
        boolean[] fail={false}, converge={true};
        server.createContext("/", exchange -> {
            String path=exchange.getRequestURI().getPath();
            Map<String,Object> value;
            int code=200;
            if (path.endsWith("/scale")) {
                if (!exchange.getRequestMethod().equals("GET")) {
                    desired.set(((Number)((Map<?,?>)json.readValue(exchange.getRequestBody(),Map.class).get("spec")).get("replicas")).intValue());
                    writes.incrementAndGet();
                }
                value=Map.of("apiVersion","autoscaling/v1","kind","Scale","metadata",Map.of("name","app","namespace","demo","resourceVersion","1"),"spec",Map.of("replicas",desired.get()),"status",Map.of("replicas",desired.get()));
            } else if (path.endsWith("/deployments/app")) {
                value=Map.of("apiVersion","apps/v1","kind","Deployment","metadata",Map.of("name","app","namespace","demo","uid","dep","generation",1),
                    "spec",Map.of("replicas",desired.get(),"selector",Map.of("matchLabels",Map.of("app","test")),"template",Map.of("spec",Map.of("containers",List.of(Map.of("name","app","image","test-only:1"))))),
                    "status",Map.of("readyReplicas",converge[0]?desired.get():0,"availableReplicas",desired.get(),"updatedReplicas",desired.get(),"replicas",desired.get(),"observedGeneration",1));
            } else if (path.endsWith("/replicasets")) {
                value=Map.of("apiVersion","apps/v1","kind","ReplicaSetList","items",List.of(Map.of("metadata",Map.of("uid","rs","ownerReferences",List.of(Map.of("uid","dep"))))));
            } else {
                List<Object> pods=new ArrayList<>();
                for (int i=0;i<desired.get();i++) pods.add(Map.of("metadata",Map.of("name","test-"+i,"ownerReferences",List.of(Map.of("uid","rs"))),"status",Map.of("phase","Running","conditions",List.of(Map.of("type","Ready","status","True")))));
                value=Map.of("apiVersion","v1","kind","PodList","items",pods);
                if (fail[0]) {code=403;value=Map.of("apiVersion","v1","kind","Status","message","TEST ONLY permission denied","reason","Forbidden","code",403);}
            }
            byte[] bytes=json.writeValueAsBytes(value);exchange.getResponseHeaders().add("Content-Type","application/json");
            exchange.sendResponseHeaders(code,bytes.length);exchange.getResponseBody().write(bytes);exchange.close();
        });
        server.start();
        var config=new ConfigBuilder().withMasterUrl("http://127.0.0.1:"+server.getAddress().getPort()).withNamespace("demo").withRequestTimeout(2000).build();
        try (var client=new KubernetesClientBuilder().withConfig(config).build()) {
            List<Map<String,Object>> observations=new ArrayList<>();
            for (int target : new int[]{100,1}) {
                ClusterControlResource.observe(client,"demo","app",target,10000,v -> observations.add(new LinkedHashMap<>(v)));
                var result=observations.getLast(); assertEquals("complete",result.get("status"));assertNotNull(result.get("duration_ms"));
                assertEquals(target,desired.get());
            }
            ClusterControlResource.observe(client,"demo","app",1,10000,observations::add);
            assertEquals("already-at-target",observations.getLast().get("status"));assertNull(observations.getLast().get("duration_ms"));
            assertEquals(2,writes.get());
            fail[0]=true;
            assertThrows(RuntimeException.class,() -> ClusterControlResource.observe(client,"demo","app",100,10000,observations::add));
            assertEquals("failed",observations.getLast().get("status"));assertNull(observations.getLast().get("duration_ms"));
            fail[0]=false; converge[0]=false;
            ClusterControlResource.observe(client,"demo","app",1,0,observations::add);
            assertEquals("timed-out",observations.getLast().get("status"));assertNull(observations.getLast().get("duration_ms"));
        } finally {server.stop(0);}
    }
}
