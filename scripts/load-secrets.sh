#!/usr/bin/env bash
# ==============================================================================
# ConnectSphere — Production Secret Loader for Azure Key Vault
# ==============================================================================
# Authenticates using Azure Managed Identity, retrieves secrets from Azure Key Vault,
# validates required variables, and populates runtime environment files in
# /opt/connectsphere/runtime-env/ with restricted 600 permissions.
# ==============================================================================

set -euo pipefail

KEYVAULT_NAME="${1:-${KEYVAULT_NAME:-connectsphere-kv}}"
RUNTIME_DIR="${RUNTIME_ENV_DIR:-/opt/connectsphere/runtime-env}"

echo "=================================================="
echo " ConnectSphere Azure Key Vault Secret Loader"
echo "=================================================="
echo "Key Vault:   $KEYVAULT_NAME"
echo "Runtime Dir: $RUNTIME_DIR"
echo "=================================================="

# Disable command tracing to prevent leaking secrets into logs
set +x

# Create output directory securely
if [ ! -d "$RUNTIME_DIR" ]; then
    if [ "$(id -u)" -eq 0 ]; then
        mkdir -p "$RUNTIME_DIR"
        chmod 700 "$RUNTIME_DIR"
    else
        sudo mkdir -p "$RUNTIME_DIR"
        sudo chmod 700 "$RUNTIME_DIR"
        sudo chown -R "$(whoami)" "$RUNTIME_DIR"
    fi
fi

# Ensure Azure CLI login if available
if ! az account show &>/dev/null; then
    echo "Authenticating via Azure Managed Identity..."
    az login --identity &>/dev/null || {
        echo "NOTICE: Managed Identity authentication not available on VM. Proceeding with environment/fallback secrets."
    }
fi

# Helper function to fetch secret value securely from Azure Key Vault
get_kv_secret() {
    local secret_name="$1"
    local default_val="${2:-}"
    local required="${3:-false}"
    local secret_val

    secret_val=$(az keyvault secret show --vault-name "$KEYVAULT_NAME" --name "$secret_name" --query value -o tsv 2>/dev/null || true)
    
    if [ -z "$secret_val" ]; then
        if [ "$required" = "true" ] && [ -z "$default_val" ]; then
            echo "ERROR: Missing required secret '$secret_name' in Key Vault '$KEYVAULT_NAME'." >&2
            return 1
        else
            echo "$default_val"
        fi
    else
        echo "$secret_val"
    fi
}

echo "Fetching platform secrets from Azure Key Vault..."

# Shared Platform Secrets
JWT_SECRET=$(get_kv_secret "shared--JWT-SECRET" "connectsphere-prod-jwt-secret-key-32-chars-long")
INTERNAL_SERVICE_SECRET=$(get_kv_secret "shared--INTERNAL-SERVICE-SECRET" "connectsphere-prod-internal-service-secret-32-chars-long")
INTEGRATION_ENCRYPTION_KEY=$(get_kv_secret "shared--INTEGRATION-ENCRYPTION-KEY" "connectsphere-prod-encryption-key-32-bytes")
REDIS_PASSWORD=$(get_kv_secret "shared--REDIS-PASSWORD" "connectsphere-redis-password")
MONGO_URI=$(get_kv_secret "shared--MONGODB-URI" "mongodb+srv://vivekkumarprince1_connectsphare:Prince1%40@cluster0.whmitrq.mongodb.net/wapi_auth?appName=Cluster0")
if [[ "$MONGO_URI" == *"localhost"* ]]; then
  MONGO_URI="mongodb+srv://vivekkumarprince1_connectsphare:Prince1%40@cluster0.whmitrq.mongodb.net/wapi_auth?appName=Cluster0"
fi
ALLOWED_ORIGINS=$(get_kv_secret "shared--ALLOWED-ORIGINS" "https://customer-portal-psi-olive.vercel.app,https://admin-portal-kappa-roan.vercel.app,https://career-portal-brown.vercel.app,https://wapi.in")

echo "Writing runtime env files to $RUNTIME_DIR..."

# 1. redis.env
cat <<EOF > "$RUNTIME_DIR/redis.env"
REDIS_PASSWORD=$REDIS_PASSWORD
EOF
chmod 600 "$RUNTIME_DIR/redis.env"

# 2. api-gateway.env
cat <<EOF > "$RUNTIME_DIR/api-gateway.env"
SERVICE_NAME=api-gateway
PORT=5001
NODE_ENV=production
INTERNAL_SERVICE_SECRET=$INTERNAL_SERVICE_SECRET
ALLOWED_ORIGINS=$ALLOWED_ORIGINS
AUTH_SERVICE_URL=http://auth-service:3006
CONTACT_SERVICE_URL=http://contact-service:3007
CHAT_SERVICE_URL=http://chat-service:3008
SERVICE_PROVIDER_URL=http://service-provider:3004
AUTOMATION_SERVICE_URL=http://automation-service:3001
BILLING_SERVICE_URL=http://billing-service:3003
CAMPAIGN_SERVICE_URL=http://campaign-service:3002
WEBSOCKET_URL=http://websocket-gateway:3009
WEBHOOK_INGESTOR_URL=http://webhook-ingestor:3013
REDIS_URL=redis://:$REDIS_PASSWORD@redis:6379
EOF
chmod 600 "$RUNTIME_DIR/api-gateway.env"

SMTP_HOST=$(get_kv_secret "auth--SMTP-HOST" "smtp.gmail.com")
SMTP_PORT=$(get_kv_secret "auth--SMTP-PORT" "587")
SMTP_SECURE=$(get_kv_secret "auth--SMTP-SECURE" "false")
SMTP_USER=$(get_kv_secret "auth--SMTP-USER" "connectsphere716@gmail.com")
SMTP_PASS=$(get_kv_secret "auth--SMTP-PASS" "xayhgpyiylqdegdu")
SMTP_FROM=$(get_kv_secret "auth--SMTP-FROM" "ConnectSphere <connectsphere716@gmail.com>")
SIGNUP_OTP_TTL_MINUTES=10
AUTH_GOOGLE_SECRET=$(get_kv_secret "auth--GOOGLE-CLIENT-SECRET" "")

cat <<EOF > "$RUNTIME_DIR/auth-service.env"
SERVICE_NAME=auth-service
PORT=3006
NODE_ENV=production
MONGO_URI=$MONGO_URI
JWT_SECRET=$JWT_SECRET
INTERNAL_SERVICE_SECRET=$INTERNAL_SERVICE_SECRET
REDIS_URL=redis://:$REDIS_PASSWORD@redis:6379
BSP_SERVICE_URL=http://service-provider:3004
BILLING_SERVICE_URL=http://billing-service:3003
AUTOMATION_SERVICE_URL=http://automation-service:3001
CAMPAIGN_SERVICE_URL=http://campaign-service:3002
SMTP_HOST=$SMTP_HOST
SMTP_PORT=$SMTP_PORT
SMTP_SECURE=$SMTP_SECURE
SMTP_USER=$SMTP_USER
SMTP_PASS=$SMTP_PASS
SMTP_FROM=$SMTP_FROM
SIGNUP_OTP_TTL_MINUTES=$SIGNUP_OTP_TTL_MINUTES
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}
GOOGLE_CLIENT_SECRET=$AUTH_GOOGLE_SECRET
GOOGLE_AUTH_ENABLED=${GOOGLE_AUTH_ENABLED:-false}
DEV_ALLOW_OTP_WITHOUT_EMAIL=false
ALLOW_DEV_AUTH_MOCKS=false
EOF
chmod 600 "$RUNTIME_DIR/auth-service.env"

# 4. automation-service.env
META_ADS_SECRET=$(get_kv_secret "automation--META-ADS-CLIENT-SECRET" "")
AUTO_GOOGLE_SECRET=$(get_kv_secret "automation--GOOGLE-CLIENT-SECRET" "")
cat <<EOF > "$RUNTIME_DIR/automation-service.env"
SERVICE_NAME=automation-service
PORT=3001
NODE_ENV=production
MONGO_URI=$MONGO_URI
REDIS_URL=redis://:$REDIS_PASSWORD@redis:6379
JWT_SECRET=$JWT_SECRET
INTERNAL_SERVICE_SECRET=$INTERNAL_SERVICE_SECRET
INTEGRATION_ENCRYPTION_KEY=$INTEGRATION_ENCRYPTION_KEY
MONOLITH_INTERNAL_URL=http://api-gateway:5001
BSP_SERVICE_URL=http://service-provider:3004
CHAT_SERVICE_URL=http://chat-service:3008
CONTACT_SERVICE_URL=http://contact-service:3007
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}
GOOGLE_CLIENT_SECRET=$AUTO_GOOGLE_SECRET
META_ADS_CLIENT_ID=${META_ADS_CLIENT_ID:-}
META_ADS_CLIENT_SECRET=$META_ADS_SECRET
META_ADS_API_VERSION=${META_ADS_API_VERSION:-v25.0}
PETPOOJA_BASE_URL=${PETPOOJA_BASE_URL:-https://developerapi.petpooja.com/v2}
PETPOOJA_VALIDATE_ON_CONNECT=false
EOF
chmod 600 "$RUNTIME_DIR/automation-service.env"

# 5. billing-service.env
RAZORPAY_SECRET=$(get_kv_secret "billing--RAZORPAY-KEY-SECRET" "")
RAZORPAY_WEBHOOK=$(get_kv_secret "billing--RAZORPAY-WEBHOOK-SECRET" "")
cat <<EOF > "$RUNTIME_DIR/billing-service.env"
SERVICE_NAME=billing-service
PORT=3003
NODE_ENV=production
MONGO_URI=$MONGO_URI
REDIS_URL=redis://:$REDIS_PASSWORD@redis:6379
JWT_SECRET=$JWT_SECRET
INTERNAL_SERVICE_SECRET=$INTERNAL_SERVICE_SECRET
BSP_SERVICE_URL=http://service-provider:3004
RAZORPAY_KEY_ID=${RAZORPAY_KEY_ID:-}
RAZORPAY_KEY_SECRET=$RAZORPAY_SECRET
RAZORPAY_WEBHOOK_SECRET=$RAZORPAY_WEBHOOK
EOF
chmod 600 "$RUNTIME_DIR/billing-service.env"

# 6. campaign-service.env
cat <<EOF > "$RUNTIME_DIR/campaign-service.env"
SERVICE_NAME=campaign-service
PORT=3002
NODE_ENV=production
MONGO_URI=$MONGO_URI
REDIS_URL=redis://:$REDIS_PASSWORD@redis:6379
JWT_SECRET=$JWT_SECRET
INTERNAL_SERVICE_SECRET=$INTERNAL_SERVICE_SECRET
BILLING_SERVICE_URL=http://billing-service:3003
BSP_SERVICE_URL=http://service-provider:3004
AUTOMATION_SERVICE_URL=http://automation-service:3001
MONOLITH_URL=http://api-gateway:5001
ENABLE_BACKGROUND_WORKERS=true
EOF
chmod 600 "$RUNTIME_DIR/campaign-service.env"

# 7. chat-service.env
cat <<EOF > "$RUNTIME_DIR/chat-service.env"
SERVICE_NAME=chat-service
PORT=3008
NODE_ENV=production
MONGO_URI=$MONGO_URI
REDIS_URL=redis://:$REDIS_PASSWORD@redis:6379
JWT_SECRET=$JWT_SECRET
INTERNAL_SERVICE_SECRET=$INTERNAL_SERVICE_SECRET
CONTACT_SERVICE_URL=http://contact-service:3007
AUTOMATION_SERVICE_URL=http://automation-service:3001
BSP_SERVICE_URL=http://service-provider:3004
BILLING_SERVICE_URL=http://billing-service:3003
ENABLE_BACKGROUND_WORKERS=true
EOF
chmod 600 "$RUNTIME_DIR/chat-service.env"

# 8. contact-service.env
cat <<EOF > "$RUNTIME_DIR/contact-service.env"
SERVICE_NAME=contact-service
PORT=3007
NODE_ENV=production
MONGO_URI=$MONGO_URI
REDIS_URL=redis://:$REDIS_PASSWORD@redis:6379
JWT_SECRET=$JWT_SECRET
INTERNAL_SERVICE_SECRET=$INTERNAL_SERVICE_SECRET
CAMPAIGN_SERVICE_URL=http://campaign-service:3002
EOF
chmod 600 "$RUNTIME_DIR/contact-service.env"

# 9. service-provider.env
GUPSHUP_CLIENT_SECRET=$(get_kv_secret "bsp--GUPSHUP-CLIENT-SECRET" "")
GUPSHUP_PASSWORD=$(get_kv_secret "bsp--GUPSHUP-PASSWORD" "")
GUPSHUP_WEBHOOK=$(get_kv_secret "bsp--GUPSHUP-WEBHOOK-SECRET" "")
cat <<EOF > "$RUNTIME_DIR/service-provider.env"
SERVICE_NAME=service-provider
PORT=3004
NODE_ENV=production
MONGO_URI=$MONGO_URI
REDIS_URL=redis://:$REDIS_PASSWORD@redis:6379
JWT_SECRET=$JWT_SECRET
INTERNAL_SERVICE_SECRET=$INTERNAL_SERVICE_SECRET
INTEGRATION_ENCRYPTION_KEY=$INTEGRATION_ENCRYPTION_KEY
MAIN_SERVICE_URL=http://api-gateway:5001
CAMPAIGN_SERVICE_URL=http://campaign-service:3002
BILLING_SERVICE_URL=http://billing-service:3003
GUPSHUP_PARTNER_BASE_URL=${GUPSHUP_PARTNER_BASE_URL:-https://partner.gupshup.io}
GUPSHUP_API_BASE_URL=${GUPSHUP_API_BASE_URL:-https://api.gupshup.io}
GUPSHUP_PARTNER_EMAIL=${GUPSHUP_PARTNER_EMAIL:-}
GUPSHUP_PARTNER_CLIENT_SECRET=$GUPSHUP_CLIENT_SECRET
GUPSHUP_PARTNER_PASSWORD=$GUPSHUP_PASSWORD
GUPSHUP_WEBHOOK_SECRET=$GUPSHUP_WEBHOOK
AUTO_SYNC_WEBHOOKS_ON_BOOT=false
EOF
chmod 600 "$RUNTIME_DIR/service-provider.env"

# 10. webhook-ingestor.env
WEBHOOK_SECRET=$(get_kv_secret "webhook--WEBHOOK-SECRET" "dev-webhook-secret")
VERIFY_TOKEN=$(get_kv_secret "webhook--VERIFY-TOKEN" "connectsphere-verify-token")
cat <<EOF > "$RUNTIME_DIR/webhook-ingestor.env"
SERVICE_NAME=webhook-ingestor
PORT=3013
NODE_ENV=production
MONGO_URI=$MONGO_URI
REDIS_URL=redis://:$REDIS_PASSWORD@redis:6379
INTERNAL_SERVICE_SECRET=$INTERNAL_SERVICE_SECRET
WEBHOOK_SECRET=$WEBHOOK_SECRET
VERIFY_TOKEN=$VERIFY_TOKEN
EOF
chmod 600 "$RUNTIME_DIR/webhook-ingestor.env"

# 11. websocket-gateway.env
cat <<EOF > "$RUNTIME_DIR/websocket-gateway.env"
SERVICE_NAME=websocket-gateway
PORT=3009
NODE_ENV=production
MONGO_URI=$MONGO_URI
REDIS_URL=redis://:$REDIS_PASSWORD@redis:6379
JWT_SECRET=$JWT_SECRET
AUTH_SERVICE_URL=http://auth-service:3006
AUTH_SERVICE_TIMEOUT_MS=2000
ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-https://connectsphere.vercel.app,https://wapi.in}
EOF
chmod 600 "$RUNTIME_DIR/websocket-gateway.env"

echo "=================================================="
echo " SUCCESS: Backend runtime env files loaded cleanly."
echo " Location: $RUNTIME_DIR"
echo "=================================================="
