import { createHmac, timingSafeEqual } from "node:crypto";
import { Kafka } from "kafkajs";

const kafka = new Kafka({ clientId: "payment-webhook", brokers: ["kafka.harbor.internal:9092"] });
const producer = kafka.producer();

interface HttpEvent {
  body: string;
  headers: Record<string, string | undefined>;
}

function signed(event: HttpEvent, secret: string): boolean {
  const given = Buffer.from(event.headers["tidewater-signature"] ?? "", "hex");
  const want = createHmac("sha256", secret).update(event.body).digest();
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Tidewater calls this when a charge settles; the result goes to Kafka for the Orders service. */
export async function handle(event: HttpEvent) {
  if (!signed(event, process.env.TIDEWATER_SIGNING_SECRET ?? "")) return { statusCode: 401 };
  const charge = JSON.parse(event.body) as { id: string; reference: string; status: string };
  await producer.connect();
  await producer.send({
    topic: "payments.settled",
    messages: [{ key: charge.reference, value: JSON.stringify(charge) }],
  });
  return { statusCode: 204 };
}
