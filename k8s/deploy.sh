#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
#  TerzoCloud — Minikube Deployment Script
#  Usage:  chmod +x deploy.sh && ./deploy.sh
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
IMAGE_NAME="terzocloud/asset-portal:latest"

# ── Step 1: Check prerequisites ─────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
echo "  TerzoCloud — Minikube Deployment"
echo "═══════════════════════════════════════════════════"
echo ""

command -v minikube >/dev/null 2>&1 || error "minikube not installed. Install: https://minikube.sigs.k8s.io/docs/start/"
command -v kubectl  >/dev/null 2>&1 || error "kubectl not installed. Install: https://kubernetes.io/docs/tasks/tools/"
info "Prerequisites OK (minikube + kubectl found)"

# ── Step 2: Start Minikube if not running ────────────────────────────────────
if ! minikube status --format='{{.Host}}' 2>/dev/null | grep -q Running; then
  warn "Minikube not running — starting with 3GB RAM, 2 CPUs..."
  minikube start --cpus=2 --memory=3072 --driver=docker
fi
info "Minikube is running"

# ── Step 3: Enable Ingress addon ─────────────────────────────────────────────
if ! minikube addons list 2>/dev/null | grep "ingress " | grep -q "enabled"; then
  warn "Enabling NGINX Ingress Controller..."
  minikube addons enable ingress
  echo "    Waiting for ingress controller to be ready..."
  kubectl wait --namespace ingress-nginx \
    --for=condition=ready pod \
    --selector=app.kubernetes.io/component=controller \
    --timeout=180s 2>/dev/null || warn "Ingress controller may still be starting"
fi
info "Ingress addon enabled"

# ── Step 5: Build the app image using minikube image build ───────────────────
# This builds directly inside minikube's container runtime (works reliably on
# macOS ARM64 with the docker driver, unlike docker build + minikube docker-env)
info "Preparing build files..."
# Some host setups keep files as owner-only (600) with ACLs; minikube/buildkit may
# copy these as empty files into the image. Normalize permissions before build.
if command -v xattr >/dev/null 2>&1; then
  xattr -rc "$PROJECT_DIR" >/dev/null 2>&1 || true
fi
find "$PROJECT_DIR" \
  \( -path "$PROJECT_DIR/.git" -o -path "$PROJECT_DIR/node_modules" \) -prune -o \
  -type d -exec chmod 755 {} + >/dev/null 2>&1 || true
find "$PROJECT_DIR" \
  \( -path "$PROJECT_DIR/.git" -o -path "$PROJECT_DIR/node_modules" \) -prune -o \
  -type f -exec chmod 644 {} + >/dev/null 2>&1 || true
find "$PROJECT_DIR" \
  \( -path "$PROJECT_DIR/.git" -o -path "$PROJECT_DIR/node_modules" \) -prune -o \
  -name "*.sh" -type f -exec chmod 755 {} + >/dev/null 2>&1 || true

node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$PROJECT_DIR/package.json" \
  || error "package.json is not valid JSON (or not readable)"

info "Building $IMAGE_NAME inside Minikube..."
minikube image rm "$IMAGE_NAME" >/dev/null 2>&1 || true
if ! minikube image build -t "$IMAGE_NAME" "$PROJECT_DIR"; then
  error "Minikube image build failed"
fi

if ! minikube image ls | grep -Eq "(^|[[:space:]])(docker\\.io/)?terzocloud/asset-portal:latest($|[[:space:]])"; then
  error "Image build did not produce $IMAGE_NAME"
fi
info "Docker image built successfully"

# ── Step 6: Apply Kubernetes manifests ───────────────────────────────────────
info "Applying Kubernetes manifests..."
kubectl apply -f "$SCRIPT_DIR/namespace.yaml"
kubectl apply -f "$SCRIPT_DIR/secrets.yaml"
kubectl apply -f "$SCRIPT_DIR/configmap.yaml"
kubectl apply -f "$SCRIPT_DIR/mongo.yaml"

# Wait for MongoDB PVC to bind and pod to be ready
echo "    Waiting for MongoDB to be ready (up to 5 minutes)..."
kubectl wait --for=jsonpath='{.status.phase}'=Bound pvc/mongo-data-mongo-0 -n terzo --timeout=120s 2>/dev/null || true
kubectl rollout status statefulset/mongo -n terzo --timeout=300s

kubectl apply -f "$SCRIPT_DIR/app.yaml"
kubectl apply -f "$SCRIPT_DIR/ingress.yaml"

# Force new pods even when image tag stays "latest"
kubectl rollout restart deployment/terzo-app -n terzo >/dev/null

# Wait for app to be ready
echo "    Waiting for Terzo app to be ready..."
kubectl rollout status deployment/terzo-app -n terzo --timeout=180s

info "All resources deployed successfully"

# ── Step 7: Show status ─────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
echo "  Deployment Status"
echo "═══════════════════════════════════════════════════"
echo ""
kubectl get all -n terzo
echo ""
kubectl get ingress -n terzo
echo ""

# ── Step 8: Get access info ──────────────────────────────────────────────────
MINIKUBE_IP=$(minikube ip 2>/dev/null || echo "127.0.0.1")

echo "═══════════════════════════════════════════════════"
echo "  Access Your Application"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  Minikube IP: $MINIKUBE_IP"
echo ""
echo "  STEP 1 — Local access:"
echo "    minikube service terzo-app-svc -n terzo"
echo "    (This opens the app in your browser automatically)"
echo ""
echo "  STEP 2 — Public internet access (using ngrok):"
echo "    Terminal 1:  minikube tunnel"
echo "    Terminal 2:  ngrok http 80"
echo ""
echo "    ngrok will give you a public URL like:"
echo "    https://xxxx-xxxx.ngrok-free.app"
echo "    Share that URL with anyone to access your app!"
echo ""
echo "═══════════════════════════════════════════════════"
