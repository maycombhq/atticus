using Microsoft.EntityFrameworkCore;

namespace Forge.Orders.Tests;

// Test code: never catalogued.
public class FakeDbContext : DbContext
{
    public DbSet<FakeThing> Things { get; set; }
}

public class FakeThing
{
    public int Id { get; set; }
}
