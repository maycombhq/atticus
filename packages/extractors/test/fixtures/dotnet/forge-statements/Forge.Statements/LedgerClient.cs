using System.Net.Http.Json;
using Confluent.Kafka;
using Refit;

namespace Forge.Statements;

public record Balance(string AccountId, decimal Amount);

public class LedgerClient
{
    private readonly HttpClient _http;

    public LedgerClient(HttpClient http) => _http = http;

    public Task<Balance?> GetBalance(string accountId) =>
        _http.GetFromJsonAsync<Balance>($"accounts/{accountId}/balance");

    public async Task Hold(string accountId)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"accounts/{accountId}/holds");
        await _http.SendAsync(request);
    }
}

public interface IAuditApi
{
    [Post("/audit/events")]
    Task Record([Body] object auditEvent);
}

public class StatementEvents(IProducer<string, string> producer)
{
    public Task Generated(string statementId) =>
        producer.ProduceAsync("statements.generated", new Message<string, string> { Value = statementId });
}
