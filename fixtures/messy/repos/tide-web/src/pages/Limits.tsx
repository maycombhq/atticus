import { lantern } from "@tide/lantern";
import { Services } from "../api/services";

export async function raiseLimit(amount: number) {
  return lantern.call(Services.BFF, "POST", "/limits", { amount });
}

export function Limits() {
  return <button onClick={() => raiseLimit(500)}>Raise my limit</button>;
}
