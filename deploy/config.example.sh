#!/usr/bin/env bash
# =============================================================================
# Clawmail — deployment configuration
#
# Usage:
#   cp deploy/config.example.sh deploy/config.sh
#   # Fill in all values below
#   ./deploy/clawmail.sh deploy
#
# NEVER commit deploy/config.sh — it contains secrets.
# =============================================================================

# -----------------------------------------------------------------------------
# GCP project settings
# -----------------------------------------------------------------------------
export CLAWMAIL_GCP_PROJECT="your-gcp-project-id"
export CLAWMAIL_GCP_REGION="us-central1"
export CLAWMAIL_GCP_ZONE="us-central1-a"

# GCS bucket for Terraform remote state (must be globally unique, created automatically)
export CLAWMAIL_TF_STATE_BUCKET="clawmail-tfstate-${CLAWMAIL_GCP_PROJECT}"

# -----------------------------------------------------------------------------
# Mail domain
# Pre-configured domain for agent email accounts.
# Agents choose only the local part — the domain is fixed.
# Example: if CLAWMAIL_DOMAIN=mail.example.com, then create_account("alice")
#          → alice@mail.example.com
# -----------------------------------------------------------------------------
export CLAWMAIL_DOMAIN="mail.yourdomain.com"

# -----------------------------------------------------------------------------
# Stalwart mail server credentials
# -----------------------------------------------------------------------------
export CLAWMAIL_STALWART_ADMIN_PASSWORD="changeme-use-something-strong"

# -----------------------------------------------------------------------------
# Cloud SQL — PostgreSQL password
# -----------------------------------------------------------------------------
export CLAWMAIL_DB_PASSWORD="changeme-use-something-strong"

# -----------------------------------------------------------------------------
# Mailgun — outbound SMTP relay
# Required: GCP blocks outbound port 25.
# Get these from: https://app.mailgun.com/mg/sending/domains
# -----------------------------------------------------------------------------
export CLAWMAIL_MAILGUN_SMTP_USER="postmaster@mg.yourdomain.com"
export CLAWMAIL_MAILGUN_SMTP_PASSWORD="your-mailgun-smtp-password"

# -----------------------------------------------------------------------------
# MCP server API keys
# Comma-separated list of valid API keys for MCP callers.
# Each key should be a random 32+ character string.
# Example: openssl rand -hex 32
# -----------------------------------------------------------------------------
export CLAWMAIL_MCP_API_KEYS="changeme-key-1,changeme-key-2"
