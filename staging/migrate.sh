#!/bin/bash
# Run the 12.x offline DB migration on STAGING, timed. Run ON the server from the staging dir.
# Do not interrupt. If it passes 2 h, stop and report (jellyfin#17840 index hang).
set -uo pipefail
cd /home/admin/services/jellyfin-staging
log=migrate-$(date +%Y%m%d-%H%M).log
t0=$(date +%s)
docker compose run --rm --no-deps jellyfin-staging --mode MigrateSystem 2>&1 | tee "$log"
rc=${PIPESTATUS[0]}
echo "MIGRATE rc=$rc duration=$(( $(date +%s)-t0 ))s" | tee -a "$log"
exit $rc
