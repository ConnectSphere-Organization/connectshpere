# ConnectSphere Azure deployment incident report

**Assessed:** 2026-08-09 (IST)  
**Subscription:** `Azure subscription 1` (`d44d7a5a-736b-41f7-8e72-0ac62815ab24`)  
**Resource group:** `rg-saas-enterprise-prod` / `eastus2`  
**Overall status:** infrastructure recovered; application deployment is unavailable.

## Executive summary

The deployment did not stop because `eastus2` itself is unavailable. Initial AKS provisioning was blocked by three configuration choices that were invalid for this subscription/region: unsupported Kubernetes versions, an unavailable VM SKU, and an AKS service CIDR that overlapped the VNet. The current Terraform configuration corrects all three, and AKS is now healthy.

The active outage is now at the image-delivery layer. Argo CD has successfully applied all 13 application manifests, but every application is `Degraded` because the expected images do not exist in `acrsaasprod.azurecr.io`. The ACR repository list was empty at assessment time. A leftover `saas-portals` Deployment is also running an obsolete registry hostname and cannot mount secrets because its `SecretProviderClass` lacks `tenantId`.

## Evidence and timeline (UTC)

| Time | Result | Azure evidence |
| --- | --- | --- |
| 2026-08-08 07:44 | AKS create failed | Old API version `2023-06-02-preview` was not registered/supported for `eastus2`. |
| 07:58 and 08:05 | AKS create failed | Requested Kubernetes `1.29.15`, then `1.30.14`; both were unsupported in the region. |
| 08:08 | AKS create failed | `Standard_D4s_v5` was not allowed in this subscription in `eastus2`. |
| 08:13 | AKS create failed | `ServiceCidrOverlapExistingSubnetsCidr`: service CIDR `10.0.0.0/16` overlapped AKS subnet `10.0.0.0/20`. |
| 08:15 onward | AKS created successfully | Current cluster `aks-saas-prod`: Kubernetes `1.34.9`, six Ready nodes, system pool `Standard_D4s_v6`, user pool `Standard_D8s_v6`. |
| 08:33 | Guide validation failed | Command referenced non-existent `aks-saas-production`; actual cluster is `aks-saas-prod`. |
| ~16:00 onward | App rollout failed | 13 Argo CD Applications are `Synced` but `Degraded`; production Pods show `ErrImagePull` / `ImagePullBackOff`. |

## Current resource state

| Component | State | Notes |
| --- | --- | --- |
| Resource group, VNet, public IP | Succeeded | Correctly provisioned in `eastus2`. |
| AKS | Succeeded / healthy | 6/6 nodes Ready; OIDC, workload identity and Key Vault CSI add-on enabled. |
| ACR | Succeeded | Premium `acrsaasprod.azurecr.io`; admin user disabled. **No repositories exist.** |
| Key Vault | Succeeded | `kvsaasprod9rmf1t`, RBAC enabled. CSI secret rotation succeeds for the 13 current services. |
| Cluster add-ons | Healthy | Argo CD, ingress-nginx, cert-manager, KEDA, Prometheus/Grafana and Loki are running. |
| Production services | Unavailable | Thirteen service Pods cannot pull `:latest` image tags. |

## Root causes

1. **AKS configuration was iteratively corrected after Azure rejected it.** Current source reflects the corrections:
   - Kubernetes `1.34`
   - `Standard_D4s_v6` / `Standard_D8s_v6`
   - service CIDR `172.16.0.0/16` (non-overlapping)
2. **Container images were never pushed to the live ACR, or were pushed to a different registry.** Live deployments request names such as `acrsaasprod.azurecr.io/api-gateway:latest`, while ACR has zero repositories. This is the immediate blocker for every intended production application.
3. **Deployment documentation is stale.** It specifies `aks-saas-production` and `kv-saas-production`, but live Terraform created `aks-saas-prod` and randomized Key Vault `kvsaasprod9rmf1t`.
4. **A stale/orphan `saas-portals` Deployment remains in production.** It points to `acrsaasproduction.azurecr.io/service:latest` (non-live ACR name) and its SecretProviderClass uses `kv-saas-production` with no `tenantId`; Azure CSI reports `tenantId is not provided`.

## Recommended recovery sequence

1. Confirm the CI/CD workflow's registry target and credentials use `acrsaasprod.azurecr.io`; build and push each required image with an immutable commit tag. Do not rely solely on `latest`.
2. Verify images exist before sync:
   `az acr repository list -g rg-saas-enterprise-prod -n acrsaasprod`.
3. Update Helm/Argo values to those immutable tags, then allow Argo CD to sync. Confirm Pods become `Ready` and Argo health changes to `Healthy`.
4. Remove or correct the obsolete `saas-portals` Deployment and SecretProviderClass after identifying its owning manifest; it is not one of the 13 current Argo Applications.
5. Update the deployment guide to use Terraform outputs, not hard-coded AKS/Key Vault names:
   `terraform output aks_cluster_name`, `terraform output key_vault_name`, and `terraform output acr_login_server`.
6. Add preflight checks to CI before Terraform apply: supported AKS version, permitted VM SKU, CIDR overlap validation, and an ACR image-existence gate before Argo sync.

## Validation gates after recovery

```bash
kubectl get nodes
kubectl get applications.argoproj.io -n argocd
kubectl get pods -n production
kubectl get ingress -n production
```

Success requires all production Pods to be Ready, every Argo Application to be `Synced` and `Healthy`, and no `ImagePullBackOff`, `ErrImagePull`, or `FailedMount` events.
