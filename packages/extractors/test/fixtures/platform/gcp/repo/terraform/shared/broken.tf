resource "google_pubsub_topic" "alerts" {
  name = "ops.alerts"
}

resource "google_pubsub_topic" "half" {
  name = "half.done"
