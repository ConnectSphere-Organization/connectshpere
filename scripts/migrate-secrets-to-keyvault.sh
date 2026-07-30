#!/usr/bin/env bash
# ==============================================================================
# ConnectSphere — Secret Migration to Azure Key Vault
# ==============================================================================
# Safely migrates production secrets into Azure Key Vault.
# Never logs secret values to standard output or terminal history.
# ==============================================================================

set -euo pipefail

KEYVAULT_NAME="${1:-${KEYVAULT_NAME:-connectsphere-kv}}"
INPUT_ENV_FILE="${2:-}"

echo "=================================================="
echo " ConnectSphere Key Vault Secret Migration Tool"
echo "=================================================="
echo "Key Vault Target: $KEYVAULT_NAME"
echo "=================================================="

# Disable command tracing
set +x

if ! command -v az &>/dev/null; then
    echo "ERROR: Azure CLI ('az') is not installed."
    exit 1
fi

if ! az account show &>/dev/null; then
    echo "Authenticating with Azure..."
    az login || { echo "Azure login failed."; exit 1; }
fi

# Function to safely store secret
set_kv_secret() {
    local secret_name="$1"
    local secret_val="$2"

    if [ -z "$secret_val" ]; then
        echo "Skipping '$secret_name' (value is empty)."
        return 0
    fi

    echo -n "Uploading secret '$secret_name' to Key Vault... "
    az keyvault secret set --vault-name "$KEYVAULT_NAME" --name "$secret_name" --value "$secret_val" --output none 2>/dev/null
    echo "DONE."
}

if [ -n "$INPUT_ENV_FILE" ] && [ -f "$INPUT_ENV_FILE" ]; then
    echo "Reading environment variables from file: $INPUT_ENV_FILE"
    echo "WARNING: Ensure $INPUT_ENV_FILE does not remain on disk post-migration."
    
    # Read key=value lines without printing values
    while IFS='=' read -r key val || [ -n "$key" ]; do
        # Ignore comments and empty lines
        [[ "$key" =~ ^#.*$ ]] && continue
        [[ -z "$key" ]] && continue
        
        # Strip trailing carriage return / whitespace
        key=$(echo "$key" | xargs)
        val=$(echo "$val" | xargs)

        # Map common keys to Key Vault secret format
        case "$key" in
            JWT_SECRET) set_kv_secret "shared--JWT-SECRET" "$val" ;;
            INTERNAL_SERVICE_SECRET) set_kv_secret "shared--INTERNAL-SERVICE-SECRET" "$val" ;;
            INTEGRATION_ENCRYPTION_KEY) set_kv_secret "shared--INTEGRATION-ENCRYPTION-KEY" "$val" ;;
            REDIS_PASSWORD) set_kv_secret "shared--REDIS-PASSWORD" "$val" ;;
            MONGO_URI|MONGODB_URI) set_kv_secret "shared--MONGODB-URI" "$val" ;;
            RAZORPAY_KEY_SECRET) set_kv_secret "billing--RAZORPAY-KEY-SECRET" "$val" ;;
            RAZORPAY_WEBHOOK_SECRET) set_kv_secret "billing--RAZORPAY-WEBHOOK-SECRET" "$val" ;;
            GUPSHUP_PARTNER_CLIENT_SECRET) set_kv_secret "bsp--GUPSHUP-CLIENT-SECRET" "$val" ;;
            GUPSHUP_PARTNER_PASSWORD) set_kv_secret "bsp--GUPSHUP-PASSWORD" "$val" ;;
            GUPSHUP_WEBHOOK_SECRET) set_kv_secret "bsp--GUPSHUP-WEBHOOK-SECRET" "$val" ;;
            WEBHOOK_SECRET) set_kv_secret "webhook--WEBHOOK-SECRET" "$val" ;;
            VERIFY_TOKEN) set_kv_secret "webhook--VERIFY-TOKEN" "$val" ;;
            BETTER_AUTH_SECRET) set_kv_secret "career--BETTER-AUTH-SECRET" "$val" ;;
            CONTRACT_ENCRYPTION_KEY) set_kv_secret "career--CONTRACT-KEY" "$val" ;;
            WEBHOOK_ENCRYPTION_KEY) set_kv_secret "career--WEBHOOK-KEY" "$val" ;;
            *) echo "Notice: Key '$key' skipped (not in production secrets inventory)." ;;
        esac
    done < "$INPUT_ENV_FILE"
else
    echo "No input file provided. Interactive secret entry mode:"
    read -rsp "Enter shared--JWT-SECRET: " jwt_sec; echo
    set_kv_secret "shared--JWT-SECRET" "$jwt_sec"

    read -rsp "Enter shared--INTERNAL-SERVICE-SECRET: " int_sec; echo
    set_kv_secret "shared--INTERNAL-SERVICE-SECRET" "$int_sec"

    read -rsp "Enter shared--MONGODB-URI: " mongo_uri; echo
    set_kv_secret "shared--MONGODB-URI" "$mongo_uri"

    read -rsp "Enter shared--REDIS-PASSWORD: " redis_pw; echo
    set_kv_secret "shared--REDIS-PASSWORD" "$redis_pw"
fi

echo "=================================================="
echo " Migration Complete for Key Vault '$KEYVAULT_NAME'."
echo "=================================================="
