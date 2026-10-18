using Microsoft.AspNetCore.Mvc;

namespace Forge.Statements.Controllers;

[ApiController]
[Route("api/[controller]")]
public class StatementsController : ControllerBase
{
    private readonly LedgerClient _ledger;

    public StatementsController(LedgerClient ledger) => _ledger = ledger;

    [HttpGet("{accountId}")]
    public async Task<IActionResult> Get(string accountId) =>
        Ok(await _ledger.GetBalance(accountId));

    [HttpPost("{accountId:guid}/regenerate")]
    public IActionResult Regenerate(Guid accountId) => Accepted();

    /* [HttpDelete("{accountId}")]
    public IActionResult Delete(string accountId) => NoContent(); */

    [HttpGet("/internal/ping"), Produces("text/plain")]
    public string Ping() => "[HttpGet(\"not-a-route\")]";
}
