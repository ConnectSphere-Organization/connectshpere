#!/usr/bin/env bash
set -euo pipefail

cat <<'EOF'
ConnectSphere VM bootstrap is retired.

Use the AKS/GitOps deployment flow instead:
- GitHub Actions workflow: .github/workflows/deploy-aks-gitops.yml
- Helm chart: deploy/helm/connectsphere
- GitOps repo: the repository configured in the workflow variables
- Runtime platform: AKS + Argo CD

This script is kept only as a compatibility stub and should not be used for new deployments.
EOF

exit 1
