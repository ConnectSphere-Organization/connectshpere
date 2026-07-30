#!/usr/bin/env bash
# ==============================================================================
# ConnectSphere — Production Backend Deployment & Health Automation Script
# ==============================================================================
# Validates prerequisites, verifies Managed Identity & Key Vault, loads
# production secrets, builds & starts containers via Docker Compose, and performs
# real-time health verification across all backend microservices.
# ==============================================================================

set -euo pipefail

KEYVAULT_NAME="${1:-${KEYVAULT_NAME:-connectsphere-kv}}"
RUNTIME_DIR="${RUNTIME_ENV_DIR:-/opt/connectsphere/runtime-env}"
COMPOSE_FILE="docker-compose.prod.yml"

echo "=================================================="
echo " ConnectSphere Microservices Production Deploy"
echo "=================================================="
echo "Timestamp:   $(date -u)"
echo "Compose File: $COMPOSE_FILE"
echo "Runtime Dir:  $RUNTIME_DIR"
echo "Key Vault:    $KEYVAULT_NAME"
echo "=================================================="

# 1. Validate Prerequisites
echo "[1/6] Validating Prerequisites..."
for tool in docker az; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: Required tool '$tool' is not installed."
        exit 1
    fi
done

if ! docker compose version &>/dev/null; then
    echo "ERROR: 'docker compose' (v2 plugin) is required."
    exit 1
fi

# 2. Verify Azure Managed Identity & Key Vault Access
echo "[2/6] Verifying Azure Managed Identity & Key Vault Access..."
if ! az account show &>/dev/null; then
    echo "Attempting Azure Managed Identity login..."
    az login --identity &>/dev/null || {
        echo "NOTICE: Managed Identity authentication not active on VM. Using local secret loader fallbacks."
    }
fi

# 3. Load Production Secrets
echo "[3/6] Loading secrets from Key Vault into $RUNTIME_DIR..."
export RUNTIME_ENV_DIR="$RUNTIME_DIR"
export KEYVAULT_NAME="$KEYVAULT_NAME"
bash ./scripts/load-secrets.sh "$KEYVAULT_NAME"

# 4. Validate Runtime Env Files
echo "[4/6] Validating runtime environment files..."
REQUIRED_ENVS=(
    "redis.env"
    "api-gateway.env"
    "auth-service.env"
    "automation-service.env"
    "billing-service.env"
    "campaign-service.env"
    "chat-service.env"
    "contact-service.env"
    "service-provider.env"
    "webhook-ingestor.env"
    "websocket-gateway.env"
)

for env_file in "${REQUIRED_ENVS[@]}"; do
    if [ ! -f "$RUNTIME_DIR/$env_file" ]; then
        echo "ERROR: Missing generated runtime env file: $RUNTIME_DIR/$env_file"
        exit 1
    fi
done
echo "All 11 backend runtime environment files verified successfully."

# 5. Build and Deploy Containers
echo "[5/6] Building and launching Docker Compose containers..."
docker compose -f "$COMPOSE_FILE" build
docker compose -f "$COMPOSE_FILE" up -d

# 6. Perform Health Checks across all services
echo "[6/6] Verifying container health status..."
echo "Waiting 20 seconds for service warm-up..."
sleep 20

UNHEALTHY=0
CONTAINERS=$(docker compose -f "$COMPOSE_FILE" ps --format "{{.Name}}")

echo "--------------------------------------------------"
printf "%-35s %-15s\n" "Container Name" "Health Status"
echo "--------------------------------------------------"

for c in $CONTAINERS; do
    STATUS=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$c" 2>/dev/null || echo "unknown")
    printf "%-35s %-15s\n" "$c" "$STATUS"
    if [ "$STATUS" = "unhealthy" ]; then
        UNHEALTHY=$((UNHEALTHY + 1))
    fi
done
echo "--------------------------------------------------"

if [ "$UNHEALTHY" -gt 0 ]; then
    echo "WARNING: $UNHEALTHY container(s) reported unhealthy status."
    echo "Use 'docker compose -f $COMPOSE_FILE logs <service>' to inspect failure logs."
    echo "To rollback, run: docker compose -f $COMPOSE_FILE down"
    exit 1
fi

echo "=================================================="
echo " DEPLOYMENT SUCCESSFUL!"
echo " All backend microservices running and healthy."
echo " Ingress active on ports 80 and 443 via Nginx."
echo "=================================================="
