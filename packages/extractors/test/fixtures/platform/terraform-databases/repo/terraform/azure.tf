resource "azurerm_postgresql_flexible_server" "catalog" {
  name    = "forge-catalog-pg"
  version = "16"
}

resource "azurerm_mssql_server" "reports" {
  name    = "forge-reports-sql"
  version = "12.0"
}
