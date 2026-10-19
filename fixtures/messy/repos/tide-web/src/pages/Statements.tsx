import { useApi } from "@tide/lantern";
import { Services } from "../api/services";

export function Statements({ id }: { id: string }) {
  const { data } = useApi({ service: Services.BFF, path: `/statements/${id}`, method: "GET" });
  return <section className="statements">{data?.lines?.length ?? 0} lines</section>;
}
