# Forge production on GCP. Invented project and names.

variable "env" {
  type    = string
  default = "prod"
}

locals {
  project = "forge-prod-1234"
}

resource "google_cloud_run_v2_service" "ledger" {
  name     = "ledger-api"
  location = "europe-west1"

  template {
    scaling {
      min_instance_count = 2
      max_instance_count = 10
    }
    containers {
      image = "europe-docker.pkg.dev/forge/ledger-api:1.4.2"
      resources {
        limits = {
          cpu    = "2"
          memory = "1Gi"
        }
      }
    }
  }
}

resource "google_cloud_run_service" "reports" {
  name     = "reports-job-${var.env}"
  location = "europe-west1"

  template {
    metadata {
      annotations = {
        "autoscaling.knative.dev/maxScale" = "3"
      }
    }
    spec {
      containers {
        image = "europe-docker.pkg.dev/forge/reports-job:0.9.0"
        resources {
          limits = {
            memory = "2Gi"
          }
        }
      }
    }
  }
}

resource "google_pubsub_topic" "payments_initiated" {
  name = "payments.initiated"
}

/* The subscriber is named by a label. */
resource "google_pubsub_subscription" "reports_transfers" {
  name  = "reports-transfers-completed"
  topic = google_pubsub_topic.transfers_completed.name
  labels = {
    component = "reports-job"
  }
}

resource "google_pubsub_topic" "transfers_completed" {
  name = "transfers.completed"
}

// A push subscription: the endpoint's host names the subscriber.
resource "google_pubsub_subscription" "notify_payments" {
  name  = "notify-payments"
  topic = "projects/${local.project}/topics/payments.initiated"
  push_config {
    push_endpoint = "https://notify-svc.forge.internal/push/payments"
  }
}

resource "google_pubsub_subscription" "audit_tap" {
  name  = "audit-tap"
  topic = google_pubsub_topic.payments_initiated.name
}

resource "google_project_iam_member" "ledger_sql" {
  project = local.project
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:ledger-api@forge-prod-1234.iam.gserviceaccount.com"
}

resource "google_project_iam_binding" "subscribers" {
  project = local.project
  role    = "roles/pubsub.subscriber"
  members = [
    "serviceAccount:reports-job@forge-prod-1234.iam.gserviceaccount.com",
    "group:forge-oncall@example.com",
    "user:someone@example.com",
  ]
}

resource "google_sql_database_instance" "ledger_db" {
  name             = "ledger-db"
  database_version = "POSTGRES_15"
}

resource "google_compute_network" "vpc" {
  name                    = "forge-vpc"
  auto_create_subnetworks = false
}
