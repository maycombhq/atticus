# Forge's Azure estate (invented). One resource of each type the terraform-azure dialect reads,
# and some it leaves to built-in readers (the storage container) or to no record (the AKS cluster).

variable "env" {
  default = "prod"
}

# ---- messaging
resource "azurerm_servicebus_queue" "orders_in" {
  name         = "orders-in"
  namespace_id = azurerm_servicebus_namespace.main.id
}

resource "azurerm_servicebus_topic" "order_events" {
  name         = "order-events"
  namespace_id = azurerm_servicebus_namespace.main.id
}

resource "azurerm_eventhub" "telemetry" {
  name              = "device-telemetry"
  namespace_name    = "forge-hubs"
  partition_count   = 4
  message_retention = 1
}

# ---- compute
resource "azurerm_linux_function_app" "billing" {
  name = "billing-func"
  tags = {
    env = var.env
  }
}

resource "azurerm_windows_function_app" "legacy_billing" {
  name = "legacy-billing-func"
}

resource "azurerm_function_app" "notifier" {
  name = "notifier-func"
}

resource "azurerm_linux_web_app" "portal" {
  name = "portal-web"
  tags = {
    env = var.env
  }
}

resource "azurerm_windows_web_app" "backoffice" {
  name = "backoffice-web"
}

resource "azurerm_app_service" "statements" {
  name = "statements-web"
}

resource "azurerm_kubernetes_cluster" "main" {
  name = "forge-aks"
}

# ---- gateway
resource "azurerm_api_management_api" "orders" {
  name                = "orders-api"
  api_management_name = "forge-apim"
  display_name        = "Orders API"
  path                = "orders"
  service_url         = "https://orders.forge.internal"
  revision            = "1"
}

# ---- data
resource "azurerm_cosmosdb_account" "catalog" {
  name       = "forge-catalog"
  offer_type = "Standard"
}

resource "azurerm_mssql_server" "reports" {
  name    = "forge-reports-sql"
  version = "12.0"
}

resource "azurerm_postgresql_flexible_server" "ledger" {
  name    = "forge-ledger-pg"
  version = "16"
}

resource "azurerm_postgresql_server" "legacy" {
  name = "forge-legacy-pg"
}

resource "azurerm_mysql_flexible_server" "loyalty" {
  name = "forge-loyalty-mysql"
}

resource "azurerm_redis_cache" "sessions" {
  name = "forge-sessions"
}

# Read by the cloud-stores extractor, not by the dialect.
resource "azurerm_storage_container" "statements" {
  name = "statements"
}
