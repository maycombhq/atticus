# Every database resource type the infra extractor read with a regex before ADR 0063.
resource "google_sql_database_instance" "ledger" {
  name             = "ledger-db"
  database_version = "POSTGRES_15"
  settings {
    tier = "db-custom-2-7680"
  }
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
