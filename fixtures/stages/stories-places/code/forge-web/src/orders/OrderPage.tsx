import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getOrder, type Order } from "../api/orders";
import { QuoteList } from "../shared/QuoteList";

/** One order: its status and the notes staff wrote on it. */
export function OrderPage() {
  const [order, setOrder] = useState<Order>();
  const [missing, setMissing] = useState(false);
  const { orderId } = useParams();

  useEffect(() => {
    getOrder(orderId!).then(setOrder, (e) => {
      if (e.status === 404) setMissing(true);
    });
  }, [orderId]);

  if (missing) return <p>This order isn't found.</p>;
  if (!order) return <p>Loading…</p>;

  return (
    <section>
      <h1>Order {order.id}</h1>
      <QuoteList quotes={[]} />
      <dl>
        <dt>Status</dt>
        <dd>
          {order.status}
          {/* the status, as the order has it */}
        </dd>
      </dl>
    </section>
  );
}
