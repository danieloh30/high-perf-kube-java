package org.acme;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.apps.Deployment;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.smallrye.common.annotation.Blocking;
import io.vertx.core.http.HttpServerRequest;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.inject.Instance;
import jakarta.inject.Inject;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.*;
import org.eclipse.microprofile.config.inject.ConfigProperty;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.*;
import java.util.function.Consumer;

/** Opt-in, loopback-only Kubernetes API control. Never executes a shell or accepts credentials. */
@Path("/demo/cluster-control")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
@ApplicationScoped
@Blocking
public class ClusterControlResource {
    @ConfigProperty(name="demo.cluster-control.enabled", defaultValue="false") boolean enabled;
    @ConfigProperty(name="demo.cluster-control.namespace", defaultValue="high-perf-java") String namespace;
    @ConfigProperty(name="demo.cluster-control.deployment", defaultValue="high-perf-java") String deployment;
    @ConfigProperty(name="demo.cluster-control.observation-path") Optional<String> observationPath;
    @Inject Instance<KubernetesClient> clients;
    @Inject ObjectMapper mapper;
    private final String token = UUID.randomUUID().toString();
    private volatile boolean running;
    private volatile Map<String,Object> observation = Map.of();

    static boolean localRequest(String remote, URI uri, String origin, String fetchSite) {
        if (!("127.0.0.1".equals(remote) || "::1".equals(remote) || "0:0:0:0:0:0:0:1".equals(remote))) return false;
        if (!Set.of("localhost", "127.0.0.1", "[::1]", "::1").contains(uri.getHost())) return false;
        if (fetchSite != null && !Set.of("same-origin", "none").contains(fetchSite)) return false;
        return origin == null || origin.equals(uri.getScheme() + "://" + uri.getRawAuthority());
    }
    boolean permitted(HttpServerRequest request, UriInfo uri) {
        return enabled && System.getenv("KUBERNETES_SERVICE_HOST") == null
            && localRequest(request.remoteAddress().hostAddress(), uri.getBaseUri(), request.getHeader("Origin"), request.getHeader("Sec-Fetch-Site"));
    }
    @GET
    public Response status(@Context HttpServerRequest request, @Context UriInfo uri) {
        boolean allowed = permitted(request, uri);
        Map<String,Object> result = new LinkedHashMap<>();
        result.put("enabled", allowed);
        result.put("namespace", namespace); result.put("deployment", deployment);
        if (allowed) {
            var config = clients.get().getConfiguration();
            result.put("context", config.getCurrentContext()==null ? "unknown (verify local kubeconfig)" : config.getCurrentContext().getName());
            URI server = URI.create(config.getMasterUrl());
            result.put("api_server", server.getScheme() + "://" + server.getHost() + (server.getPort()==-1 ? "" : ":" + server.getPort()));
            result.put("token", token); result.put("running", running); result.put("observation", observation);
        } else result.put("reason", "Direct scaling is disabled. On your local machine run oc login, then DEMO_CLUSTER_CONTROL=true ./demo.sh up. Control is unavailable from a cluster-hosted dashboard.");
        return Response.ok(result).header("Cache-Control", "no-store").build();
    }
    public record ScaleRequest(int replicas) {}
    @POST @Path("/scale")
    public synchronized Response scale(ScaleRequest body, @HeaderParam("X-Demo-Control") String provided,
            @Context HttpServerRequest request, @Context UriInfo uri) {
        if (!permitted(request, uri) || !token.equals(provided)) throw new ForbiddenException("Local opt-in and same-origin control token required.");
        if (body == null || (body.replicas() != 1 && body.replicas() != 100)) throw new BadRequestException("Only the 1 and 100 replica demo targets are allowed.");
        if (running) throw new ClientErrorException("A scale observation is already running.", 409);
        if (!namespace.matches("[a-z0-9](?:[-a-z0-9]*[a-z0-9])?") || !deployment.matches("[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?"))
            throw new BadRequestException("Invalid configured target.");
        running = true;
        observation = Map.of("kind", "scale", "status", "connecting", "target", body.replicas(), "namespace", namespace, "deployment", deployment, "timestamp", Instant.now().toString());
        Thread.ofVirtual().name("demo-scale-observer").start(() -> {
            try { observe(clients.get(), namespace, deployment, body.replicas(), 300_000, this::publish); }
            catch (Exception e) { publish(Map.of("kind", "scale", "status", "failed", "target", body.replicas(), "namespace", namespace, "deployment", deployment, "timestamp", Instant.now().toString(), "reason", "Kubernetes API operation failed. Check local oc login, context, RBAC and connectivity; no rollback was performed.")); }
            finally { running = false; }
        });
        return Response.accepted(Map.of("status", "accepted")).build();
    }
    private void publish(Map<String,Object> value) {
        observation = Collections.unmodifiableMap(new LinkedHashMap<>(value));
        observationPath.ifPresent(file -> {
            try {
                java.nio.file.Path path=java.nio.file.Path.of(file); Files.createDirectories(path.getParent());
                java.nio.file.Path temporary=path.resolveSibling("control-latest.tmp");
                mapper.writeValue(temporary.toFile(), value);
                Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (Exception ignored) { /* In-memory status remains available when disk evidence cannot be written. */ }
        });
    }

    static void observe(KubernetesClient client, String ns, String name, int target, long timeoutMs, Consumer<Map<String,Object>> publish) throws InterruptedException {
        var operation=client.apps().deployments().inNamespace(ns).withName(name);
        Deployment initial=operation.get();
        if (initial==null) throw new NotFoundException("Deployment not found");
        String uid=initial.getMetadata().getUid();
        var template=initial.getSpec().getTemplate();
        var selector=initial.getSpec().getSelector();
        if (selector.getMatchLabels()==null || selector.getMatchLabels().isEmpty() || (selector.getMatchExpressions()!=null && !selector.getMatchExpressions().isEmpty()))
            throw new BadRequestException("A matchLabels Deployment selector is required.");
        Map<String,Object> record=new LinkedHashMap<>();
        record.put("version",1); record.put("kind","scale"); record.put("namespace",ns); record.put("deployment",name);
        record.put("deployment_uid",uid); record.put("from_replicas",initial.getSpec().getReplicas()); record.put("target",target);
        record.put("timestamp",Instant.now().toString()); record.put("source","quarkus-kubernetes-client; local kubeconfig context");
        record.put("context",client.getConfiguration().getCurrentContext()==null ? "unknown" : client.getConfiguration().getCurrentContext().getName());
        record.put("boundary","before Kubernetes scale API request to observed Ready + Available target and excess owned pods terminated; includes API latency and 2s polling");
        record.put("images",template.getSpec().getContainers().stream().map(c -> Map.of("name", c.getName(), "image", c.getImage(), "resources", c.getResources()==null ? Map.of() : c.getResources())).toList());
        record.put("duration_ms",null);
        List<Map<String,Object>> timeline=new ArrayList<>(); record.put("timeline",List.of());
        if (Objects.equals(initial.getSpec().getReplicas(),target)) {
            record.put("status","already-at-target"); record.put("reason","No scale change requested; not a scale-time measurement."); publish.accept(record); return;
        }
        long start=System.nanoTime();
        try {
            operation.scale(target, false);
            while (true) {
                Deployment current=operation.get();
                if (current==null || !uid.equals(current.getMetadata().getUid()) || !template.equals(current.getSpec().getTemplate()) || !Objects.equals(target,current.getSpec().getReplicas()))
                    throw new IllegalStateException("Deployment identity, template or desired count changed during observation.");
                Set<String> sets=new HashSet<>();
                client.apps().replicaSets().inNamespace(ns).withLabels(selector.getMatchLabels()).list().getItems().stream()
                    .filter(r -> r.getMetadata().getOwnerReferences().stream().anyMatch(o -> uid.equals(o.getUid())))
                    .forEach(r -> sets.add(r.getMetadata().getUid()));
                List<Pod> pods=client.pods().inNamespace(ns).withLabels(selector.getMatchLabels()).list().getItems().stream()
                    .filter(p -> p.getMetadata().getOwnerReferences().stream().anyMatch(o -> sets.contains(o.getUid()))).toList();
                var status=current.getStatus();
                int ready=status==null ? 0 : count(status.getReadyReplicas()), available=status==null ? 0 : count(status.getAvailableReplicas()),
                    updated=status==null ? 0 : count(status.getUpdatedReplicas()), replicas=status==null ? 0 : count(status.getReplicas());
                long terminating=pods.stream().filter(p -> p.getMetadata().getDeletionTimestamp()!=null).count(),
                    readyPods=pods.stream().filter(p -> p.getStatus()!=null && p.getStatus().getConditions()!=null && p.getStatus().getConditions().stream().anyMatch(c -> "Ready".equals(c.getType()) && "True".equals(c.getStatus()))).count(),
                    pending=pods.stream().filter(p -> p.getStatus()!=null && "Pending".equals(p.getStatus().getPhase())).count();
                double elapsed=(System.nanoTime()-start)/1_000_000.0;
                timeline.add(Map.of("elapsed_ms",elapsed,"ready",ready,"available",available,"pending",pending,"terminating",terminating,"owned_pods",pods.size()));
                record.put("timeline",List.copyOf(timeline));
                boolean complete=ready==target && available==target && updated==target && replicas==target && readyPods==target && pods.size()==target && terminating==0
                    && status.getObservedGeneration()!=null && status.getObservedGeneration()>=current.getMetadata().getGeneration();
                record.put("status",complete ? "complete" : elapsed>=timeoutMs ? "timed-out" : "observing");
                if (complete) record.put("duration_ms",elapsed);
                if (elapsed>=timeoutMs && !complete) record.put("reason","Target was not observed within timeout. Desired replicas remain changed; no rollback was performed.");
                publish.accept(record);
                if (complete || elapsed>=timeoutMs) return;
                Thread.sleep(2000);
            }
        } catch (RuntimeException | InterruptedException e) {
            record.put("status","failed"); record.put("reason","API request or observation failed; check login, RBAC, connectivity and concurrent Deployment changes. No rollback was performed.");
            publish.accept(record); throw e;
        }
    }
    private static int count(Integer n) { return n==null ? 0 : n; }
}
