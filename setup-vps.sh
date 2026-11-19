#!/usr/bin/env bash
# setup-vps.sh — VPS preparation for MonooBD
#
# This script covers what Coolify does not handle:
#   - Host volume directory tree (/opt/ia/bd/)
#   - UFW firewall rules
#
# Usage: sudo bash setup-vps.sh
# Requirements: Ubuntu 22.04+ with root access, Coolify already installed

set -euo pipefail

DATA_DIR="/opt/ia/bd"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()    { echo -e "${GREEN}[✓]${NC} $*"; }
info()   { echo -e "${CYAN}[→]${NC} $*"; }
warn()   { echo -e "${YELLOW}[!]${NC} $*"; }
error()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }
section(){ echo -e "\n${CYAN}══ $* ══${NC}"; }

require_root() {
    [[ $EUID -eq 0 ]] || error "This script must be run as root: sudo bash $0"
}

create_directories() {
    section "Directory tree /opt/ia/bd"

    local dirs=(
        "${DATA_DIR}/models/Stable-diffusion"
        "${DATA_DIR}/models/ControlNet"
        "${DATA_DIR}/models/VAE"
        "${DATA_DIR}/outputs"
        "${DATA_DIR}/cn-cache"
        "${DATA_DIR}/sessions"
        "${DATA_DIR}/projects"
        "${DATA_DIR}/renders"
    )

    for d in "${dirs[@]}"; do
        mkdir -p "$d"
        log "Created: $d"
    done

    chmod -R 755 "${DATA_DIR}"
    log "Permissions set."

    # The webapp container runs as USER node (UID 1000).
    chown -R 1000:1000 "${DATA_DIR}/sessions"
    chown -R 1000:1000 "${DATA_DIR}/projects"
    chown -R 1000:1000 "${DATA_DIR}/renders"
    log "Owner of sessions, projects and renders → 1000:1000 (node)."
}

configure_firewall() {
    section "Firewall UFW"
    if ! command -v ufw &>/dev/null; then
        apt-get install -y -q ufw
    fi

    ufw allow 22   comment "SSH"
    ufw allow 80   comment "HTTP (Traefik)"
    ufw allow 443  comment "HTTPS (Traefik)"
    ufw deny  7860 comment "A1111 API (Docker internal only)"

    ufw --force enable
    log "UFW enabled."
    ufw status verbose
}

main() {
    require_root

    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║   MonooBD — VPS preparation               ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
    echo ""

    create_directories
    configure_firewall

    echo ""
    echo -e "${GREEN}VPS preparation complete.${NC}"
    echo ""
    echo -e "${CYAN}Next steps:${NC}"
    echo "  1. In Coolify: New Resource → Docker Compose → this repository"
    echo "  2. Set the environment variables (see README § Variables)"
    echo "  3. Click Deploy"
    echo ""
    echo -e "${YELLOW}Note:${NC} First start = download of ~5 GB of models."
    echo ""
}

main "$@"
