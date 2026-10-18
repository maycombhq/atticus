using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace Forge.Orders.Models;

public class Customer
{
    [Key]
    [Column("customer_code")]
    public string Code { get; set; } = "";

    public string? Email { get; set; }
}

/// Not in any DbSet: no table.
public class CustomerSummary
{
    public string Code { get; set; } = "";
    public int OrderCount { get; set; }
}
