resource "google_pubsub_topic" "reports" {
  name = "report-requests"
}

resource "google_cloudfunctions2_function" "report" {
  name     = "daily-report"
  location = "europe-west1"

  build_config {
    runtime = "python312"
  }

  event_trigger {
    event_type   = "google.cloud.pubsub.topic.v1.messagePublished"
    pubsub_topic = google_pubsub_topic.reports.id
  }
}

resource "google_cloudfunctions2_function" "quote" {
  name = "quote-api"
}
