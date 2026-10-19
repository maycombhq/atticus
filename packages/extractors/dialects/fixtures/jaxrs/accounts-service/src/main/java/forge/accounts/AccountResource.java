package forge.accounts;

import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;
import java.util.List;

@Path("/accounts")
@Produces(MediaType.APPLICATION_JSON)
public class AccountResource {

    @GET
    public List<Account> list() {
        return List.of();
    }

    @GET
    @Path("/{id}")
    public Account get(@PathParam("id") String id) {
        return null;
    }

    @Path("{id}/holds")
    @POST
    @Consumes(MediaType.APPLICATION_JSON)
    public Hold placeHold(@PathParam("id") String id, HoldRequest request) {
        return null;
    }

    @DELETE
    @Path("/{id}")
    @RolesAllowed({"admin"})
    public void close(@PathParam("id") String id) {
    }

    @PUT
    @Consumes(MediaType.APPLICATION_JSON)
    @Path("/{id}/owner")
    public Account rename(@PathParam("id") String id, RenameRequest request) {
        return null;
    }

    @GET
    @Produces(MediaType.TEXT_PLAIN)
    public String count() {
        return "0";
    }
}
