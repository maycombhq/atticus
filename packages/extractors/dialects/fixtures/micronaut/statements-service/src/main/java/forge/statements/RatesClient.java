package forge.statements;

import io.micronaut.http.annotation.Get;
import io.micronaut.http.client.annotation.Client;

@Client("https://rates.northwind-pay.example/v2")
public interface RatesClient {

    @Get("/fx/{currency}")
    Rate rate(String currency);
}
