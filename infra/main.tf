terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }

  backend "gcs" {
    bucket = "clawmail-tfstate"
    prefix = "terraform/state"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP zone for primary Stalwart VM"
  type        = string
  default     = "us-central1-a"
}

variable "zone_secondary" {
  description = "GCP zone for secondary Stalwart VM (for HA failover)"
  type        = string
  default     = "us-central1-b"
}

variable "domain" {
  description = "Mail domain (e.g. mail.clawmail.ai)"
  type        = string
}

variable "allowed_domains" {
  description = "Optional comma-separated list of additional mail domains (besides the primary domain)"
  type        = string
  default     = ""
}

variable "sendgrid_api_key" {
  description = "Twilio SendGrid API key used as SMTP password (username is always 'apikey')"
  type        = string
  sensitive   = true
}

variable "stalwart_admin_password" {
  description = "Admin password for the Stalwart mail server"
  type        = string
  sensitive   = true
}

variable "db_password" {
  description = "Password for the Cloud SQL stalwart database user"
  type        = string
  sensitive   = true
}

variable "mcp_api_key" {
  description = "API key used by the MCP Cloud Run service (legacy, all keys admin)"
  type        = string
  sensitive   = true
}

variable "mcp_api_key_map" {
  description = "JSON array mapping API keys to roles and accounts, e.g. [{\"key\":\"k\",\"role\":\"admin\"}]"
  type        = string
  sensitive   = true
  default     = ""
}

variable "dashboard_password" {
  description = "Password for the Clawmail web dashboard (username is DASHBOARD_USER, default: admin)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "mcp_server_image" {
  description = "Container image for the Clawmail MCP server"
  type        = string
  default     = "gcr.io/PROJECT/clawmail-mcp:latest"
}
