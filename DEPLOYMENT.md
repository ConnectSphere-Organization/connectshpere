# ConnectSphere Hybrid Production Deployment Guide

This guide details the complete production deployment architecture for **ConnectSphere**:
1. **Frontend Applications (`apps/`)**: Deployed on **Vercel** (`customer-portal`, `admin-portal`, `career-portal`).
2. **Backend Microservices Stack (`services/`)**: Deployed on **Microsoft Azure Linux VM (Ubuntu 24.04 LTS)** using **Docker Compose**, **Nginx Ingress**, **Local Redis Container**, **External MongoDB Atlas**, and **Azure Key Vault** via **System-Assigned Managed Identity**.

---

## 1. System Architecture Diagram

```
                        [ Users / Web Browsers ]
                                   |
                                   v
             +---------------------+---------------------+
             |         Frontend Tier (Vercel)            |
             |                                           |
    [ customer-portal ]     [ admin-portal ]     [ career-portal ]
     customer.wapi.in        admin.wapi.in        careers.wapi.in
             +---------------------+---------------------+
                                   |
                             HTTPS API Calls
                                   |
                                   v
                      [ Azure VM: Ports 80 / 443 ]
                        [ Nginx Ingress Container ]
                                   |
                         [ api-gateway:5001 ]
                                   |
     +-----------------------------+-----------------------------+
     |                             |                             |
[ auth-service ]           [ chat-service ]           [ contact-service ]
   Port 3006                      Port 3008                      Port 3007
     |                             |                             |
[ campaign-service ]       [ billing-service ]       [ automation-service ]
   Port 3002                      Port 3003                      Port 3001
     |                             |                             |
[ service-provider ]       [ webhook-ingestor ]      [ websocket-gateway ]
   Port 3004                      Port 3013                      Port 3009
     +-----------------------------+-----------------------------+
                                   |
            +----------------------+----------------------+
            |                                             |
            v                                             v
[ Local Redis Container ]                    [ External MongoDB Atlas ]
 Port 6379 (Private Network)                     Cluster Connection URI
```

---

## 2. Vercel Deployment Instructions (Frontend Apps)

Each frontend application inside the `apps/` directory is deployed to Vercel as a Next.js project.

### App 1: `apps/customer-portal`
- **Root Directory**: `apps/customer-portal`
- **Framework Preset**: Next.js
- **Environment Variables on Vercel**:
  - `BACKEND_API_URL`: `https://api.yourdomain.com` (Your Azure VM Nginx/API Gateway domain)
  - `NEXT_PUBLIC_APP_NAME`: `ConnectSphere`
  - `NEXT_PUBLIC_API_URL`: `/api`
  - `NEXT_PUBLIC_SOCKET_URL`: `https://api.yourdomain.com`
  - `NEXT_PUBLIC_GOOGLE_CLIENT_ID`: `your-google-client-id`
  - `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED`: `true`

### App 2: `apps/admin-portal`
- **Root Directory**: `apps/admin-portal`
- **Framework Preset**: Next.js
- **Environment Variables on Vercel**:
  - `GATEWAY_URL`: `https://api.yourdomain.com`
  - `INTERNAL_SERVICE_SECRET`: `same-secret-as-keyvault`
  - `MONGODB_URI`: `mongodb+srv://...` (MongoDB Atlas URI)
  - `JWT_SECRET`: `same-secret-as-keyvault`
  - `ADMIN_COOKIE_NAME`: `admin_token`
  - `CUSTOMER_PORTAL_URL`: `https://customer.yourdomain.com`

### App 3: `apps/career-portal`
- **Root Directory**: `apps/career-portal`
- **Framework Preset**: Next.js
- **Environment Variables on Vercel**:
  - `MONGODB_URI`: `mongodb+srv://...` (MongoDB Atlas URI)
  - `BETTER_AUTH_SECRET`: `high-entropy-random-secret-32-chars`
  - `BETTER_AUTH_URL`: `https://careers.yourdomain.com`
  - `APP_URL`: `https://careers.yourdomain.com`
  - `CONTRACT_ENCRYPTION_KEY`: `base64-32-bytes`
  - `WEBHOOK_ENCRYPTION_KEY`: `base64-32-bytes`

---

## 3. Azure Infrastructure Setup (Backend Tier)

### Hardware & VM Allocation
- **Subscription**: Azure for Students
- **VM**: Ubuntu 24.04 LTS (x86_64), 2 vCPU, ~892 MB physical RAM, 61 GB disk, 2 GB swap.
- **Hosted Services**: 10 backend Node.js microservices + Redis container + Nginx ingress.

### Step 1: Run Azure Managed Identity Setup
On the Azure VM:

```bash
chmod +x scripts/*.sh
./scripts/setup-azure.sh "connectsphere-kv" "connectsphere-rg" "eastus"
```

---

## 4. Key Vault Secret Inventory

| Key Vault Secret Name | Service Variable | Description |
| :--- | :--- | :--- |
| `shared--JWT-SECRET` | `JWT_SECRET` | Token signing secret across microservices |
| `shared--INTERNAL-SERVICE-SECRET` | `INTERNAL_SERVICE_SECRET` | Inter-service auth bearer secret |
| `shared--INTEGRATION-ENCRYPTION-KEY` | `INTEGRATION_ENCRYPTION_KEY` | Provider credential encryption key |
| `shared--REDIS-PASSWORD` | `REDIS_PASSWORD` | Redis container authentication password |
| `shared--MONGODB-URI` | `MONGO_URI` | MongoDB Atlas cluster connection URI |
| `shared--ALLOWED-ORIGINS` | `ALLOWED_ORIGINS` | Comma-separated Vercel app URLs (e.g. `https://*.vercel.app,https://app.yourdomain.com`) |
| `auth--SMTP-PASS` | `SMTP_PASS` | Auth service SMTP password |
| `auth--GOOGLE-CLIENT-SECRET` | `GOOGLE_CLIENT_SECRET` | Auth service Google OAuth secret |
| `automation--META-ADS-CLIENT-SECRET` | `META_ADS_CLIENT_SECRET` | Meta Ads OAuth client secret |
| `billing--RAZORPAY-KEY-SECRET` | `RAZORPAY_KEY_SECRET` | Razorpay API key secret |
| `billing--RAZORPAY-WEBHOOK-SECRET` | `RAZORPAY_WEBHOOK_SECRET` | Razorpay webhook secret |
| `bsp--GUPSHUP-CLIENT-SECRET` | `GUPSHUP_PARTNER_CLIENT_SECRET` | Gupshup partner API secret |
| `bsp--GUPSHUP-PASSWORD` | `GUPSHUP_PARTNER_PASSWORD` | Gupshup partner password |
| `bsp--GUPSHUP-WEBHOOK-SECRET` | `GUPSHUP_WEBHOOK_SECRET` | Gupshup webhook verification secret |
| `webhook--WEBHOOK-SECRET` | `WEBHOOK_SECRET` | Ingestor payload signature secret |
| `webhook--VERIFY-TOKEN` | `VERIFY_TOKEN` | Ingestor challenge verification token |

### Migrating Secrets to Key Vault
```bash
./scripts/migrate-secrets-to-keyvault.sh "connectsphere-kv"
```

---

## 5. Backend Memory Optimization (~892 MB RAM)

By shifting frontends to Vercel, the Azure VM memory footprint is significantly reduced:

| Service / Container | `NODE_OPTIONS` Heap Limit | Container RAM Limit (`mem_limit`) |
| :--- | :--- | :--- |
| `redis` | N/A (`maxmemory 96mb`) | `128M` |
| `api-gateway` | `--max-old-space-size=96` | `128M` |
| `auth-service` | `--max-old-space-size=64` | `96M` |
| `automation-service` | `--max-old-space-size=64` | `96M` |
| `billing-service` | `--max-old-space-size=56` | `80M` |
| `campaign-service` | `--max-old-space-size=64` | `96M` |
| `chat-service` | `--max-old-space-size=64` | `96M` |
| `contact-service` | `--max-old-space-size=56` | `80M` |
| `service-provider` | `--max-old-space-size=80` | `112M` |
| `webhook-ingestor` | `--max-old-space-size=56` | `80M` |
| `websocket-gateway` | `--max-old-space-size=64` | `96M` |
| `nginx` | N/A | `64M` |

Total Memory Allocation: ~980 MB peak across all 12 backend containers.

---

## 6. Azure Deployment Execution

To deploy or update backend microservices on the VM:

```bash
./scripts/deploy.sh "connectsphere-kv"
```

### Verification & Operations
```bash
# Check container status
docker compose -f docker-compose.prod.yml ps

# Monitor live VM memory utilization
free -h

# Check logs
docker compose -f docker-compose.prod.yml logs -f api-gateway
```
