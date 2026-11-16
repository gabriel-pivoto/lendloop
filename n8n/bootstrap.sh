#!/bin/sh
# First boot: import the SMTP credential and the LendLoop workflows, then
# publish (activate) the two trigger workflows. Later boots skip straight to
# `n8n start`, so edits made in the n8n UI are never overwritten.
set -e
MARKER=/home/node/.n8n/.lendloop-bootstrapped

if [ ! -f "$MARKER" ]; then
  echo "[lendloop] importing credentials and workflows"
  # The credential file holds no secret (local Mailpit). n8n encrypts it with
  # N8N_ENCRYPTION_KEY on import. Swap it for real SMTP in the UI.
  n8n import:credentials --input=/lendloop/credentials/smtp-mailpit.json
  n8n import:workflow --separate --input=/lendloop/workflows
  n8n publish:workflow --id=lendloopNotify01
  n8n publish:workflow --id=lendloopOverdue1
  # n8n 2.x only runs an error workflow that is published.
  n8n publish:workflow --id=lendloopErrors01
  touch "$MARKER"
fi

exec n8n start
