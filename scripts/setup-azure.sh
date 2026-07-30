#!/usr/bin/env bash
# ==============================================================================
# ConnectSphere — Azure Infrastructure & Managed Identity Setup
# ==============================================================================
# Sets up System-Assigned Managed Identity on the Azure Linux VM,
# creates/verifies Azure Key Vault with RBAC permissions, and prepares
# local runtime environment directories.
# ==============================================================================

set -euo pipefail

KEYVAULT_NAME="${1:-${KEYVAULT_NAME:-connectsphere-kv}}"
RESOURCE_GROUP="${2:-${RESOURCE_GROUP:-connectsphere-rg}}"
LOCATION="${3:-${LOCATION:-eastus}}"

echo "=================================================="
echo " ConnectSphere Azure VM & Key Vault Setup"
echo "=================================================="
echo "Key Vault:      $KEYVAULT_NAME"
echo "Resource Group: $RESOURCE_GROUP"
echo "Location:       $LOCATION"
echo "=================================================="

# Check prerequisite CLI
if ! command -v az &>/dev/null; then
    echo "ERROR: Azure CLI ('az') is not installed. Please install it first."
    exit 1
fi

# Ensure logged in or in VM managed identity context
if ! az account show &>/dev/null; then
    echo "Attempting login with Azure VM Managed Identity..."
    az login --identity || {
        echo "ERROR: 'az login --identity' failed. If running locally, run 'az login' interactive mode."
        exit 1
    }
fi

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
echo "Active Azure Subscription: $SUBSCRIPTION_ID"

# 1. Enable System-Assigned Managed Identity on VM if running inside Azure VM
echo "Checking Azure VM Managed Identity..."
VM_NAME=$(hostname)

if az vm show -g "$RESOURCE_GROUP" -n "$VM_NAME" &>/dev/null; then
    echo "Enabling System-Assigned Managed Identity for VM '$VM_NAME'..."
    PRINCIPAL_ID=$(az vm identity assign -g "$RESOURCE_GROUP" -n "$VM_NAME" --query systemAssignedIdentity -o tsv)
    echo "VM Principal ID: $PRINCIPAL_ID"
else
    echo "WARNING: VM '$VM_NAME' not found in Resource Group '$RESOURCE_GROUP'. Skipping 'az vm identity assign'."
    echo "If executing outside the VM, ensure Managed Identity is enabled on the target VM."
    PRINCIPAL_ID=""
fi

# 2. Create or verify Azure Key Vault
echo "Verifying Azure Key Vault '$KEYVAULT_NAME'..."
if ! az keyvault show --name "$KEYVAULT_NAME" &>/dev/null; then
    echo "Key Vault '$KEYVAULT_NAME' does not exist. Creating..."
    az keyvault create \
        --name "$KEYVAULT_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --location "$LOCATION" \
        --enable-rbac-authorization true
    echo "Key Vault created successfully with Azure RBAC enabled."
else
    echo "Key Vault '$KEYVAULT_NAME' exists."
fi

KV_RESOURCE_ID=$(az keyvault show --name "$KEYVAULT_NAME" --query id -o tsv)

# 3. Grant RBAC Role to VM Managed Identity
if [ -n "$PRINCIPAL_ID" ]; then
    echo "Granting 'Key Vault Secrets User' role to VM identity..."
    az role assignment create \
        --assignee-object-id "$PRINCIPAL_ID" \
        --assignee-principal-type ServicePrincipal \
        --role "Key Vault Secrets User" \
        --scope "$KV_RESOURCE_ID" || echo "Role assignment already exists or assigned."
fi

# 4. Prepare local runtime environment directory
RUNTIME_DIR="/opt/connectsphere/runtime-env"
echo "Setting up local runtime directory at '$RUNTIME_DIR'..."

if [ "$(id -u)" -eq 0 ]; then
    mkdir -p "$RUNTIME_DIR"
    chmod 700 "$RUNTIME_DIR"
else
    sudo mkdir -p "$RUNTIME_DIR"
    sudo chmod 700 "$RUNTIME_DIR"
    sudo chown -R "$(whoami)" "$RUNTIME_DIR"
fi

echo "=================================================="
echo " SUCCESS: Azure Setup & Key Vault Verification Complete!"
echo " Directory ready: $RUNTIME_DIR (chmod 700)"
echo "=================================================="
