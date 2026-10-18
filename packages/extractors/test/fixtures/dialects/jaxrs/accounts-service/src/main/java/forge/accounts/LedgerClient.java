package forge.accounts;

import jakarta.ws.rs.*;
import org.eclipse.microprofile.rest.client.inject.RegisterRestClient;

@Path("/ledger/v1")
@RegisterRestClient(configKey = "ledger-api")
public interface LedgerClient {

    @GET
    @Path("/accounts/{id}/balance")
    Balance balance(@PathParam("id") String id);

    @Path("/transfers")
    @POST
    Transfer transfer(TransferRequest request);
}
