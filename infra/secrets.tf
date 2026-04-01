# ---------------------------------------------------------------------------
# Secret Manager — enable API + store all sensitive values
# ---------------------------------------------------------------------------

resource "google_project_service" "secretmanager" {
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# Helper local to keep secret definitions DRY
# ---------------------------------------------------------------------------

locals {
  secrets = {
    "stalwart-admin-password" = var.stalwart_admin_password
    "mailgun-smtp-user"       = var.mailgun_smtp_user
    "mailgun-smtp-password"   = var.mailgun_smtp_password
    "db-password"             = var.db_password
    "mcp-api-key"             = var.mcp_api_key
  }
}

# ---------------------------------------------------------------------------
# Secret containers
# ---------------------------------------------------------------------------

resource "google_secret_manager_secret" "secrets" {
  for_each  = local.secrets
  secret_id = each.key

  replication {
    auto {}
  }

  depends_on = [google_project_service.secretmanager]
}

# ---------------------------------------------------------------------------
# Secret versions (the actual payloads)
# ---------------------------------------------------------------------------

resource "google_secret_manager_secret_version" "secrets" {
  for_each = local.secrets

  secret      = google_secret_manager_secret.secrets[each.key].id
  secret_data = each.value
}
