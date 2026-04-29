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
    public String helloName() {
        return "High Performance Kube Native Java with Quarkus";
    }
}
