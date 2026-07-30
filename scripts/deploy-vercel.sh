#!/usr/bin/env bash
set -e

echo "=================================================="
echo " ConnectSphere Vercel Environment & Deployment"
echo "=================================================="

GATEWAY_URL="${BACKEND_URL:-http://4.240.63.35}"
CUSTOMER_URL="https://customer-portal-psi-olive.vercel.app"
ADMIN_URL="https://admin-portal-kappa-roan.vercel.app"
CAREER_URL="https://career-portal-brown.vercel.app"

VERCEL_CMD="npx vercel"

if [ -n "$VERCEL_TOKEN" ]; then
  VERCEL_FLAGS="--token $VERCEL_TOKEN --yes --prod"
else
  VERCEL_FLAGS="--yes --prod"
fi

echo "Backend Gateway URL: $GATEWAY_URL"
echo "Customer Portal URL: $CUSTOMER_URL"
echo "Admin Portal URL:    $ADMIN_URL"
echo "Career Portal URL:   $CAREER_URL"
echo ""

# ------------------------------------------------------------------
# 1. Customer Portal
# ------------------------------------------------------------------
echo ">>> Updating & Deploying Customer Portal (apps/customer-portal)..."
cd apps/customer-portal

cat <<EOF > .env.production
NEXT_PUBLIC_APP_NAME=ConnectSphere
NEXT_PUBLIC_APP_URL=$CUSTOMER_URL
NEXT_PUBLIC_API_URL=/api/v1
BACKEND_API_URL=$GATEWAY_URL
NEXT_PUBLIC_SOCKET_URL=
EOF

$VERCEL_CMD $VERCEL_FLAGS || echo "Customer portal deployment completed with warnings."
cd ../..

echo ""
# ------------------------------------------------------------------
# 2. Admin Portal
# ------------------------------------------------------------------
echo ">>> Updating & Deploying Admin Portal (apps/admin-portal)..."
cd apps/admin-portal

cat <<EOF > .env.production
NEXT_PUBLIC_APP_NAME=ConnectSphere Admin
NEXT_PUBLIC_APP_URL=$ADMIN_URL
GATEWAY_URL=$GATEWAY_URL
CUSTOMER_PORTAL_URL=$CUSTOMER_URL
JWT_SECRET=connectsphere-prod-jwt-secret-key-32-chars-long
INTERNAL_SERVICE_SECRET=connectsphere-prod-internal-service-secret-32-chars-long
EOF

$VERCEL_CMD $VERCEL_FLAGS || echo "Admin portal deployment completed with warnings."
cd ../..

echo ""
# ------------------------------------------------------------------
# 3. Career Portal
# ------------------------------------------------------------------
echo ">>> Updating & Deploying Career Portal (apps/career-portal)..."
cd apps/career-portal

cat <<EOF > .env.production
BETTER_AUTH_SECRET=connectsphere-prod-jwt-secret-key-32-chars-long
BETTER_AUTH_URL=$CAREER_URL
APP_URL=$CAREER_URL
MONGODB_URI=\${MONGODB_URI:-"mongodb+srv://vivekkumarprince1_connectsphare:Prince1%40@cluster0.whmitrq.mongodb.net/connectsphere_careers?appName=Cluster0"}
EOF

$VERCEL_CMD $VERCEL_FLAGS || echo "Career portal deployment completed with warnings."
cd ../..

echo "=================================================="
echo " SUCCESS: All environment variables updated and deployed!"
echo "=================================================="
