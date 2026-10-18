using Forge.Statements;
using Refit;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddHttpClient<LedgerClient>(client =>
    client.BaseAddress = new Uri(builder.Configuration["Services:Ledger:BaseUrl"]!));
builder.Services
    .AddRefitClient<IAuditApi>()
    .ConfigureHttpClient(c => c.BaseAddress = new Uri("http://audit-svc.forge.internal"));

var app = builder.Build();
app.MapControllers();
app.MapGet("/health", () => Results.Ok());

var exports = app.MapGroup("/api/exports");
exports.MapPost("/{statementId}", (string statementId) => Results.Accepted());
// app.MapGet("/debug/config", () => builder.Configuration.GetDebugView());

app.Run();
