using Microsoft.AspNetCore.Mvc;

namespace Forge.Statements.Controllers;

[ApiController]
[Route("statements")]
public class StatementsController : ControllerBase
{
    [HttpGet("{id}")]
    public IActionResult Get(string id) => Ok(new { id });
}
