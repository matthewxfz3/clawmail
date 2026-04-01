terraform {
  required_version = ">= 1.6"

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
  description = "GCP zone"
  type        = string
  default     = "us-central1-a"
}

variable "domain" {
  description = "Mail domain (e.g. mail.clawmail.ai)"
  type        = string
}

variable "mailgun_smtp_user" {
  description = "Mailgun SMTP username"
  type        = string
}

variable "mailgun_smtp_password" {
  description = "Mailgun SMTP password"
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
  description = "API key used by the MCP Cloud Run service"
  type        = string
  sensitive   = true
}

variable "mcp_server_image" {
  description = "Container image for the Clawmail MCP server"
  type        = string
  default     = "gcr.io/PROJECT/clawmail-mcp:latest"
}
