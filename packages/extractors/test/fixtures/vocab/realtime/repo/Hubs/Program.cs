var app = builder.Build();
app.MapHub<ChatHub>("/hubs/chat");
// app.MapHub<OldHub>("/hubs/old");
app.Run();
