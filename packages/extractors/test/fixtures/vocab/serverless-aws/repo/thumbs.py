from kafka import KafkaProducer

producer = KafkaProducer()


def handler(event, context):
    producer.send("thumbnails.ready", b"{}")
    # producer.send("not.this.one", b"{}")
