import { useState } from "react";
import { graph } from "../api/graph";
import { PLACE_ORDER } from "../api/operations";

interface Line {
  sku: string;
  quantity: number;
}

export function Checkout({ lines }: { lines: Line[] }) {
  const [status, setStatus] = useState<string>("draft");
  async function submit() {
    const result = await graph<{ placeOrder: { id: string; status: string } }>(PLACE_ORDER, {
      input: { lines },
    });
    setStatus(result.placeOrder.status);
  }
  return (
    <section>
      <p>Order status: {status}</p>
      <button onClick={submit}>Place order</button>
    </section>
  );
}
