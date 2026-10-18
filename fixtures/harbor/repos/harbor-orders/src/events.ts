import { Kafka } from "kafkajs";

const kafka = new Kafka({ clientId: "orders-svc", brokers: ["kafka.harbor.internal:9092"] });
const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: "orders-svc" });

export async function publishOrderPlaced(orderId: string, lines: unknown[]) {
  await producer.connect();
  await producer.send({
    topic: "orders.placed",
    messages: [{ key: orderId, value: JSON.stringify({ orderId, lines }) }],
  });
}

/** Payment results: authorized by the payments service, settled by Tidewater's callback. */
export async function startPaymentListener() {
  await consumer.connect();
  await consumer.subscribe({ topics: ["payments.authorized", "payments.settled"] });
  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      console.log(topic, message.key?.toString());
    },
  });
}
