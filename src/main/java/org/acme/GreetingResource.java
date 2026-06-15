package org.acme;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;

@Path("/hello")
public class GreetingResource {

    @GET
    @Produces(MediaType.TEXT_PLAIN)
    public String hello() {
        return "Hello Java Developers!";
    }

    @GET
    @Produces(MediaType.TEXT_PLAIN)
    @Path("perf")
    public String helloPerf() {
        return "High Performance Kube Native Java with Quarkus";
    }

    @GET
    @Produces(MediaType.TEXT_PLAIN)
    @Path("runtime")
    public String runtime() {
        String vendor = System.getProperty("java.vm.name", "JVM");
        boolean isNative = vendor.contains("Substrate") || System.getProperty("org.graalvm.nativeimage.imagecode") != null;
        return isNative ? "Running as GraalVM Native Image 🚀" : "Running on " + vendor;
    }
}
