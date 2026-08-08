resource "azurerm_container_registry" "acr" {
  name                = "acrsaas${var.environment}"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  sku                 = "Premium"
  admin_enabled       = false

  public_network_access_enabled = true
  zone_redundancy_enabled       = true

  tags = azurerm_resource_group.rg.tags
}
