# ConnectSphere Production Deployment Guide

ConnectSphere now uses a Kubernetes-first deployment model based on GitHub Actions, Azure Container Registry, Helm, and Argo CD.

## Supported deployment path

1. Frontends (`apps/customer-portal`, `apps/admin-portal`, `apps/career-portal`) continue to deploy to Vercel.
2. Backend services and portals are built and published as container images from GitHub Actions.
3. The GitOps workflow updates a Helm values file in a separate GitOps repository.
4. Argo CD synchronizes the release into AKS.

The previous VM + Docker Compose deployment path is retired and should no longer be used for production.

## Architecture

```text
Developers -> GitHub Actions -> ACR -> GitOps repo -> Argo CD -> AKS -> Helm release
```

## GitHub Actions workflow

Use the workflow at [.github/workflows/deploy-aks-gitops.yml](.github/workflows/deploy-aks-gitops.yml).

Required repository variables:
- `ACR_NAME`
- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `GITOPS_REPO`

Required secrets:
- `GITOPS_TOKEN`

## Helm and GitOps

The chart lives in [deploy/helm/connectsphere](deploy/helm/connectsphere) and the production values file is in [deploy/gitops/production-values.yaml](deploy/gitops/production-values.yaml).

The deployment flow is:
- build container images for each service/portal
- push them to ACR
- update the Helm values in the GitOps repository
- let Argo CD deploy the new image tags into AKS

## Rollback

Rollback is handled through Argo CD or by reverting the image tag change in the GitOps repository and letting Argo CD reconcile the change.

## Deprecated assets

The following are intentionally retired for production:
- [scripts/deploy.sh](scripts/deploy.sh)
- [scripts/setup-azure.sh](scripts/setup-azure.sh)
- [.github/workflows/deploy.yml](.github/workflows/deploy.yml)

Use the AKS/GitOps workflow for all new deployments.
