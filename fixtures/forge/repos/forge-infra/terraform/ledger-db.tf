resource "google_sql_database_instance" "ledger_db" {
  name             = "ledger-db"
  database_version = "POSTGRES_15"
  settings {
    backup_configuration {
      enabled = true
    }
  }
}
