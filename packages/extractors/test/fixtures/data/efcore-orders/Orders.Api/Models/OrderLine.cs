using System.ComponentModel.DataAnnotations;

namespace Forge.Orders.Models;

public class OrderLine
{
    [Key]
    public long LineId { get; set; }

    public int OrderId { get; set; }

    public Order Order { get; set; } = null!;

    public string Sku { get; set; } = "";

    public int Quantity { get; set; }
}
