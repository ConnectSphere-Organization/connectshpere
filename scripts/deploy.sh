#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
ConnectSphere VM deployment is no longer supported.

Production deployments now use:
- GitHub Actions workflow: .github/workflows/deploy-aks-gitops.yml
- Container registry: Azure Container Registry
- GitOps delivery: Argo CD + Helm charts in deploy/helm/connectsphere
- Runtime platform: AKS

Please use the GitOps workflow and the Argo CD-managed Helm release for deployments.
EOF

exit 1
