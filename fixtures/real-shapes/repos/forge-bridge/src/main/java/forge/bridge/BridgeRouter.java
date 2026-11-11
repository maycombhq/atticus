package forge.bridge;

import org.apache.camel.builder.RouteBuilder;
import org.apache.camel.model.rest.RestBindingMode;
import org.springframework.stereotype.Component;

/**
 * A Camel REST DSL route in a Spring Boot application, and a call out whose URI is a property
 * placeholder followed by a Camel simple expression.
 */
@Component
public class BridgeRouter extends RouteBuilder {

    @Override
    public void configure() throws Exception {

        // @formatter:off
        restConfiguration()
            .component("servlet")
            .bindingMode(RestBindingMode.json);

        rest("/transfers").description("Transfer bridge")
            .consumes("application/json")
            .produces("application/json")

            .get("/{id}").description("One transfer's account")
                .to("direct:account");

        from("direct:account")
            .routeId("bridge-account")
            .toD("{{forge.ledger.base-uri}}/accounts/${header.id}?bridgeEndpoint=true&throwExceptionOnFailure=false");
        // @formatter:on
    }
}
