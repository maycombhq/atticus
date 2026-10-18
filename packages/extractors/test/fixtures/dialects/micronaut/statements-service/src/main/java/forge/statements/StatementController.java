package forge.statements;

import io.micronaut.http.HttpResponse;
import io.micronaut.http.MediaType;
import io.micronaut.http.annotation.*;
import io.micronaut.http.client.HttpClient;
import io.micronaut.http.client.annotation.Client;
import jakarta.inject.Inject;
import java.util.List;

@Controller("/statements")
public class StatementController {

    @Inject
    @Client("/")
    HttpClient self;

    @Get("/{id}")
    public Statement get(String id) {
        return null;
    }

    @Get
    public List<Statement> list() {
        return List.of();
    }

    @Post(uri = "/{id}/send", consumes = MediaType.APPLICATION_JSON)
    public HttpResponse<?> send(String id) {
        return HttpResponse.accepted();
    }

    @Delete("/{id}")
    void remove(String id) {
    }
}
