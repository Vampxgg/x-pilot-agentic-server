#!/bin/bash
# Setup script for Simulation Training deployment infrastructure
#
# This script creates the necessary directories and sets up
# the deployment environment for 3D simulation training applications.
#
# Usage: bash deploy/setup-sim-training.sh [--production]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Default to development paths (within project directory)
SIM_TRAINING_BASE="${PROJECT_ROOT}/data/sim-training"

if [[ "${1:-}" == "--production" ]]; then
    SIM_TRAINING_BASE="/opt/sim-training"
    echo "=== Production mode: using ${SIM_TRAINING_BASE} ==="
else
    echo "=== Development mode: using ${SIM_TRAINING_BASE} ==="
fi

echo "Creating directory structure..."
mkdir -p "${SIM_TRAINING_BASE}/workspace"
mkdir -p "${SIM_TRAINING_BASE}/deployed"
mkdir -p "${SIM_TRAINING_BASE}/assets/icv"
mkdir -p "${SIM_TRAINING_BASE}/assets/mechanical"
mkdir -p "${SIM_TRAINING_BASE}/assets/electrical"
mkdir -p "${SIM_TRAINING_BASE}/assets/tools"

echo "Copying asset catalogs..."
if [[ -d "${PROJECT_ROOT}/data/sim-training/assets" ]]; then
    cp -r "${PROJECT_ROOT}/data/sim-training/assets/"*.json "${SIM_TRAINING_BASE}/assets/" 2>/dev/null || true
    for category in icv mechanical electrical tools; do
        if [[ -f "${PROJECT_ROOT}/data/sim-training/assets/${category}/catalog.json" ]]; then
            cp "${PROJECT_ROOT}/data/sim-training/assets/${category}/catalog.json" "${SIM_TRAINING_BASE}/assets/${category}/"
        fi
    done
fi

if [[ "${1:-}" == "--production" ]]; then
    echo ""
    echo "Production setup notes:"
    echo "  1. Copy Nginx config:    sudo cp ${SCRIPT_DIR}/nginx-sim-training.conf /etc/nginx/conf.d/"
    echo "  2. Edit server_name and alias paths in the Nginx config"
    echo "  3. Reload Nginx:         sudo nginx -s reload"
    echo "  4. Set environment var:  SIM_TRAINING_BASE_URL=https://sim.yourdomain.com"
    echo ""
    echo "  Directory structure:"
    echo "    ${SIM_TRAINING_BASE}/"
    echo "    ├── workspace/     # Build workspace (temporary)"
    echo "    ├── deployed/      # Served by Nginx"
    echo "    └── assets/        # 3D model library"
fi

echo ""
echo "Setup complete!"
echo "Template project location: ${PROJECT_ROOT}/sim-training-template/"
echo "Assets location: ${SIM_TRAINING_BASE}/assets/"
echo "Deploy location: ${SIM_TRAINING_BASE}/deployed/"
