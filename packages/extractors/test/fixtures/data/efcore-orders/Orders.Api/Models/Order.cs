using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;
using Microsoft.EntityFrameworkCore;

namespace Forge.Orders.Models;

[Table("orders")]
[Index(nameof(Reference), IsUnique = true)]
public class Order
{
    public int Id { get; set; }

    [Required]
    [Column("reference")]
    [MaxLength(32)]
    public string Reference { get; set; } = "";

    [Column("total", TypeName = "decimal(18,2)")]
    public decimal Total { get; set; }

    public DateTime? ShippedAt { get; set; }

    public OrderStatus Status { get; set; }

    public string CustomerCode { get; set; }

    public virtual Customer Customer { get; set; }

    public ICollection<OrderLine> Lines { get; set; } = new List<OrderLine>();

    [NotMapped]
    public string Label { get; set; } = "";

    public string Display => $"{Reference}";
}

public enum OrderStatus
{
    Open,
    Shipped,
}
