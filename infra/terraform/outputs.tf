output "aks_cluster_name" {
  value = azurerm_kubernetes_cluster.aks.name
}

output "acr_login_server" {
  value = azurerm_container_registry.acr.login_server
}

output "key_vault_name" {
  value = azurerm_key_vault.kv.name
}

output "ingress_public_ip" {
  value = azurerm_public_ip.ingress_pip.ip_address
}

output "admin_portal_url" {
  value = "http://${azurerm_public_ip.ingress_pip.fqdn}/"
}

output "customer_portal_url" {
  value = "http://${azurerm_public_ip.customer_portal_pip.fqdn}/"
}

output "career_portal_url" {
  value = "http://${azurerm_public_ip.career_portal_pip.fqdn}/"
}
