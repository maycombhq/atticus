namespace Harbor.Notify;

public class OrderFunctions
{
    [Function("GetOrder")]
    public object Get([HttpTrigger(AuthorizationLevel.Function, "get", Route = "orders/{id}")] object req) => null;

    [Function(nameof(Reindex))]
    public void Reindex([TimerTrigger("0 */30 * * * *")] object t) { }

    [Function("OnPayment")]
    public void OnPayment([ServiceBusTrigger("payments", "orders-sub")] string body) { }
}
