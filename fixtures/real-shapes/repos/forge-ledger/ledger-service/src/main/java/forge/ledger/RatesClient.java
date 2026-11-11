package forge.ledger;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

@Component
public class RatesClient {

    private final RestTemplate http = new RestTemplate();

    @Value("${forge.clients.rates.base-url}")
    private String baseUrl;

    public Rate rate(String currency) {
        return http.getForObject(baseUrl + "/rates/{currency}", Rate.class, currency);
    }
}
