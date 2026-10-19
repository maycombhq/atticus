package forge.accounts;

import jakarta.ws.rs.*;
import org.eclipse.microprofile.rest.client.inject.RegisterRestClient;

@RegisterRestClient(configKey = "audit-svc")
public interface AuditClient {

    @POST
    @Path("/audit/events")
    void record(AuditEvent event);
}
