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
        return "Hello from Quarkus Java";
    }

    @GET
    @Produces(MediaType.TEXT_PLAIN)
    @Path("name")
    public String helloName() {
        return "Welcome Everyone at the Red Hat Summit 2026!!!";
    }
}
