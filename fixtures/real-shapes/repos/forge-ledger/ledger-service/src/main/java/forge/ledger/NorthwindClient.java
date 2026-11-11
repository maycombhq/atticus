package forge.ledger;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

@Component
@ConfigurationProperties(prefix = "forge.clients.northwind")
public class NorthwindClient {

    private String baseUrl;

    public void setBaseUrl(String baseUrl) {
        this.baseUrl = baseUrl;
    }

    public Payout payout(String id) {
        return RestClient.create(baseUrl).get().uri("/payouts/{id}", id).retrieve().body(Payout.class);
    }
}
