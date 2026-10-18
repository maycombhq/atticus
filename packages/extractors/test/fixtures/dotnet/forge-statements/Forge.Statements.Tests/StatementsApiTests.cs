using System.Net.Http;
using Xunit;

namespace Forge.Statements.Tests;

public class StatementsApiTests
{
    [Fact]
    [HttpGet("/only-in-tests")]
    public async Task Gets_a_statement()
    {
        var client = new HttpClient { BaseAddress = new Uri("http://localhost") };
        await client.GetAsync("/api/statements/42");
    }
}
