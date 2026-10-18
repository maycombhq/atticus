using Forge.Orders.Models;
using Microsoft.EntityFrameworkCore;

namespace Forge.Orders.Data;

public class OrdersDbContext : DbContext
{
    public OrdersDbContext(DbContextOptions<OrdersDbContext> options) : base(options) { }

    public DbSet<Order> Orders { get; set; }
    public DbSet<OrderLine> OrderLines => Set<OrderLine>();
    public DbSet<Customer> Customers { get; set; } = null!;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<OrderLine>().ToTable("order_lines");
        modelBuilder.Entity<Customer>(b =>
        {
            b.ToTable("customer");
        });
    }
}
