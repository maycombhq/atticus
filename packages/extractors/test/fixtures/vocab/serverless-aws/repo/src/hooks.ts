import { Kafka } from "kafkajs";

const producer = new Kafka({ brokers: ["broker:9092"] }).producer();

export async function handle(event: { body: string }) {
  await producer.send({
    topic: "charges.settled",
    messages: [{ value: event.body }],
  });
  // producer.send({ topic: "commented.out" }) is not a publish
  return { statusCode: 204 };
}
