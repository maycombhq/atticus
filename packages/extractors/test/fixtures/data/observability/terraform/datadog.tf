resource "datadog_monitor" "bff_errors" {
  name  = "Portal BFF 5xx errors"
  type  = "metric alert"
  query = "sum(last_5m):sum:trace.http.request.errors{service:portal-bff} > 10"
  tags  = ["service:portal-bff", "team:portal"]
}

resource "datadog_dashboard" "ledger" {
  title       = "Ledger SLOs"
  layout_type = "ordered"
}

resource "google_storage_bucket" "logs" {
  name = "forge-logs"
}
