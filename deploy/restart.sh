#!/bin/bash
# Restart script for Strapi 5 on the DO server
# Copy to /home/forge/v2.hub.icjia-api.cloud/v2hub/ and run:
#   bash restart.sh

set -e

APP_DIR="/home/forge/v2.hub.icjia-api.cloud/v2hub"
PM2_NAME="strapi5-researchhub"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   Strapi 5 Restart — v2.hub.icjia-api   ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

cd "$APP_DIR" || { echo -e "${RED}ERROR: $APP_DIR not found${NC}"; exit 1; }
echo -e "Working directory: ${CYAN}$(pwd)${NC}"
echo ""

# Pull latest
echo -e "${YELLOW}Pulling latest changes...${NC}"
git pull
echo ""

# Ask about rebuild
read -p "Rebuild Strapi? (only needed after schema/plugin changes) [y/N]: " REBUILD
REBUILD=${REBUILD:-N}

if [[ "$REBUILD" =~ ^[Yy]$ ]]; then
    echo ""
    echo -e "${YELLOW}Installing dependencies...${NC}"
    npm install
    echo ""
    echo -e "${YELLOW}Building Strapi...${NC}"
    npm run build
    echo -e "${GREEN}✓ Build complete${NC}"
fi

# Restart PM2
echo ""
echo -e "${YELLOW}Restarting PM2...${NC}"
pm2 restart "$PM2_NAME"
echo -e "${GREEN}✓ PM2 restarted${NC}"

# Wait for startup
echo ""
echo -e "${YELLOW}Waiting for Strapi to start...${NC}"
sleep 5

# Show status
echo ""
pm2 status "$PM2_NAME"

# Quick health check
echo ""
echo -e "${YELLOW}Health check...${NC}"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:1337 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "403" ]; then
    echo -e "${GREEN}✓ Strapi is responding (HTTP $HTTP_CODE)${NC}"
else
    echo -e "${RED}⚠ Strapi returned HTTP $HTTP_CODE — check logs: pm2 logs $PM2_NAME${NC}"
fi

echo ""
echo -e "${GREEN}Done.${NC}"
