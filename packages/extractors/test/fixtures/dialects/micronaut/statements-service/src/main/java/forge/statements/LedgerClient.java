package forge.statements;

import io.micronaut.http.annotation.*;
import io.micronaut.http.client.annotation.Client;

@Client(id = "ledger-api", path = "/ledger/v1")
public interface LedgerClient {

    @Get("/accounts/{id}/balance")
    Balance balance(String id);

    @Post("/transfers")
    Transfer transfer(@Body TransferRequest request);
}
