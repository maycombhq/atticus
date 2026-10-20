# Forge's Google Cloud estate (invented). The terraform-gcp dialect reads the databases, caches
# and task queues; Cloud Run, Pub/Sub, Cloud Functions, buckets, BigQuery and IAM stay with the
# built-in gcp, serverless and cloud-stores readers, and a GKE cluster gives no record.

variable "region" {
  default = "europe-west1"
}

resource "google_sql_database_instance" "ledger" {
  name             = "ledger-db"
  database_version = "POSTGRES_15"
  region           = var.region
}

resource "google_sql_database_instance" "loyalty" {
  name             = "loyalty-db"
  database_version = "MYSQL_8_0"
}

resource "google_sql_database_instance" "reporting" {
  name             = "reporting-db"
  database_version = "SQLSERVER_2019_STANDARD"
}

resource "google_sql_database_instance" "scratch" {
  name = "scratch-db"
}

resource "google_redis_instance" "sessions" {
  name           = "forge-sessions"
  memory_size_gb = 1
}

resource "google_cloud_tasks_queue" "emails" {
  name     = "forge-emails"
  location = var.region
}

resource "google_spanner_database" "accounts" {
  instance = "forge-spanner"
  name     = "accounts"
}

resource "google_container_cluster" "main" {
  name = "forge-gke"
}

# Read by the gcp extractor, not by the dialect.
resource "google_pubsub_topic" "orders" {
  name = "orders"
}
