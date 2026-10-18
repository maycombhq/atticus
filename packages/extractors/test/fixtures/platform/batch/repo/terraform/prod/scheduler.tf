resource "google_cloud_run_v2_service" "reports" {
  name     = "reports-job"
  location = "europe-west1"
  template {
    containers {
      image = "europe-docker.pkg.dev/forge/reports-job:0.9.0"
    }
  }
}

resource "google_cloud_scheduler_job" "month_end" {
  name      = "month-end-close"
  schedule  = "0 22 28-31 * *"
  time_zone = "Europe/London"
  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.reports.uri}/jobs/month-end"
  }
}

resource "google_cloud_scheduler_job" "tick" {
  name     = "payments-tick"
  schedule = "*/5 * * * *"
  pubsub_target {
    topic_name = google_pubsub_topic.tick.id
    data       = base64encode("tick")
  }
}

resource "google_pubsub_topic" "tick" {
  name = "payments.tick"
}
