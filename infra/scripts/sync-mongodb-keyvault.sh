# Key Vault Secret sync helper script for MongoDB Atlas URIs
# Copies per-service MongoDB URIs into Azure Key Vault secrets for CSI driver injection

set -e

KEYVAULT_NAME="${AZURE_KEYVAULT_NAME:-kv-saas-production}"

echo "Syncing MongoDB Atlas URIs to Azure Key Vault: ${KEYVAULT_NAME}..."

SERVICES=(
  "api-gateway"
  "auth-service"
  "automation-service"
  "billing-service"
  "campaign-service"
  "chat-service"
  "contact-service"
  "service-provider"
  "webhook-ingestor"
  "websocket-gateway"
  "customer-portal"
  "admin-portal"
)

for SERVICE in "${SERVICES[@]}"; do
  ENV_VAR_NAME=$(echo "${SERVICE}" | tr '[:lower:]' '[:upper:]' | tr '-' '_')"_MONGODB_URI"
  URI_VAL="${!ENV_VAR_NAME}"
  
  if [ -n "$URI_VAL" ]; then
    echo "Updating secret mongodb-uri-${SERVICE} in Key Vault..."
    az keyvault secret set --vault-name "$KEYVAULT_NAME" --name "mongodb-uri-${SERVICE}" --value "$URI_VAL" > /dev/null
  else
    echo "Warning: ${ENV_VAR_NAME} is not set in local environment. Skipping."
  fi
done

echo "MongoDB Key Vault sync completed!"
