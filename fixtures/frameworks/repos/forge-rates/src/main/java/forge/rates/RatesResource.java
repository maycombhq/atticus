package forge.rates;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;

@Path("/rates")
public class RatesResource {

  @GET
  @Path("/today")
  public String today() {
    return "{}";
  }
}
