var app = WebApplication.CreateBuilder(args).Build();
app.MapGet("/invoices/{id}", (string id) => id);
app.Run();
