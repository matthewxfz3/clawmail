# ---------------------------------------------------------------------------
# Cloud Run v2 — Clawmail MCP server
# ---------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "clawmail_mcp" {
  name     = "clawmail-mcp"
  location = var.region

  template {
    scaling {
      min_instance_count = 0
      max_instance_count = 10
    }

    containers {
      image = var.mcp_server_image

      # Plain environment variables (non-sensitive)
      env {
        name  = "DOMAIN"
        value = var.domain
      }

      env {
        name  = "STALWART_URL"
        value = "http://${google_compute_address.stalwart.address}:8080"
      }

      # Secret-backed environment variables
      env {
        name = "STALWART_ADMIN_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["stalwart-admin-password"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "SENDGRID_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["sendgrid-api-key"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "MCP_API_KEYS"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["mcp-api-key"].secret_id
            version = "latest"
          }
        }
      }

      ports {
        container_port = 8080
      }
    }

    # Grant the revision access to the secrets it references
    service_account = google_service_account.clawmail_mcp_run.email
  }
}

# Dedicated service account for the Cloud Run revision
resource "google_service_account" "clawmail_mcp_run" {
  account_id   = "clawmail-mcp-run"
  display_name = "Clawmail MCP Cloud Run SA"
}

# Allow Cloud Run SA to access Secret Manager secrets
resource "google_project_iam_member" "clawmail_mcp_secretmanager" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.clawmail_mcp_run.email}"
}

# ---------------------------------------------------------------------------
# NOTE: Public (unauthenticated) access is intentionally NOT granted.
# The service requires authenticated callers (e.g. service-to-service OIDC
# tokens or Cloud IAP). To allow public access you would add:
#
#   resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
#     project  = google_cloud_run_v2_service.clawmail_mcp.project
#     location = google_cloud_run_v2_service.clawmail_mcp.location
#     name     = google_cloud_run_v2_service.clawmail_mcp.name
#     role     = "roles/run.invoker"
#     member   = "allUsers"
#   }
#
# DO NOT add this unless you are intentionally exposing the MCP API publicly.
# ---------------------------------------------------------------------------
