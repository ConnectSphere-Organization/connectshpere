data "azurerm_client_config" "current" {}

resource "random_string" "kv_suffix" {
  length  = 6
  special = false
  upper   = false
}

resource "azurerm_key_vault" "kv" {
  name                        = "kvsaasprod${random_string.kv_suffix.result}"
  location                    = azurerm_resource_group.rg.location
  resource_group_name         = azurerm_resource_group.rg.name
  enabled_for_disk_encryption = true
  tenant_id                   = data.azurerm_client_config.current.tenant_id
  soft_delete_retention_days  = 7
  purge_protection_enabled    = true
  sku_name                    = "standard"

  enable_rbac_authorization = true

  tags = azurerm_resource_group.rg.tags
}

resource "azurerm_role_assignment" "kv_secrets_officer" {
  scope                = azurerm_key_vault.kv.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

# Example MongoDB Atlas URI secrets setup for key vault
locals {
  services = [
    "api-gateway",
    "auth-service",
    "automation-service",
    "billing-service",
    "campaign-service",
    "chat-service",
    "contact-service",
    "service-provider",
    "webhook-ingestor",
    "websocket-gateway"
  ]
}

resource "azurerm_key_vault_secret" "mongodb_uris" {
  for_each     = toset(local.services)
  name         = "mongodb-uri-${each.value}"
  value        = "mongodb+srv://placeholder-user:placeholder-pass@atlas.mongodb.net/${each.value}?retryWrites=true&w=majority"
  key_vault_id = azurerm_key_vault.kv.id

  depends_on = [azurerm_role_assignment.kv_secrets_officer]

  lifecycle {
    ignore_changes = [value]
  }
}
