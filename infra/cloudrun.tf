# ---------------------------------------------------------------------------
# Serverless VPC Access connector — lets Cloud Run reach VPC-internal
# resources (Redis, Stalwart VM) without exposing them publicly.
# ---------------------------------------------------------------------------

resource "google_project_service" "vpcaccess" {
  service            = "vpcaccess.googleapis.com"
  disable_on_destroy = false
}

resource "google_vpc_access_connector" "clawmail" {
  depends_on = [google_project_service.vpcaccess]
  name       = "clawmail-connector"
  region     = var.region
  network    = "default"
  # /28 must not overlap with existing VPC subnets.
  # Pick a CIDR that doesn't overlap your VPC subnets in this project/region.
  ip_cidr_range = "10.8.0.0/28"
}

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
        name = "STALWART_URL"
        # Use internal IP via VPC connector — plain HTTP is fine on a trusted VPC.
        # This avoids exposing port 8443 publicly and removes the TLS skip flag.
        value = "http://${google_compute_instance.stalwart_primary.network_interface[0].network_ip}:8080"
      }

      env {
        name  = "ALLOWED_DOMAINS"
        value = var.allowed_domains
      }

      env {
        name  = "REDIS_URL"
        value = "redis://${google_redis_instance.clawmail_cache.host}:${google_redis_instance.clawmail_cache.port}"
      }

      env {
        name  = "OTEL_SERVICE_NAME"
        value = "clawmail-mcp"
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

      env {
        name = "MCP_API_KEY_MAP"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["mcp-api-key-map"].secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "DASHBOARD_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secrets["dashboard-password"].secret_id
            version = "latest"
          }
        }
      }

      ports {
        container_port = 8080
      }
    }

    vpc_access {
      connector = google_vpc_access_connector.clawmail.id
      egress    = "PRIVATE_RANGES_ONLY"
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

# Allow Cloud Run SA to access only the specific secrets it needs (least privilege)
resource "google_secret_manager_secret_iam_member" "clawmail_mcp_run_secrets" {
  for_each  = toset(["stalwart-admin-password", "sendgrid-api-key", "mcp-api-key", "mcp-api-key-map", "dashboard-password"])
  project   = var.project_id
  secret_id = google_secret_manager_secret.secrets[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.clawmail_mcp_run.email}"
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
