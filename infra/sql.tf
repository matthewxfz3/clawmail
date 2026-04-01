# ---------------------------------------------------------------------------
# Cloud SQL — PostgreSQL 15
# ---------------------------------------------------------------------------

# Private services access is required for private IP connectivity.
# Ensure the servicenetworking API is enabled and a VPC peering exists
# before applying if you switch deletion_protection to true in production.

resource "google_sql_database_instance" "clawmail" {
  name             = "clawmail"
  database_version = "POSTGRES_15"
  region           = var.region

  # Set to true before going to production to prevent accidental deletion
  deletion_protection = false

  settings {
    # Use db-f1-micro for dev; switch to db-g1-small (or larger) for production
    tier = "db-f1-micro"

    backup_configuration {
      enabled                        = true
      start_time                     = "03:00" # UTC
      point_in_time_recovery_enabled = true
    }

    ip_configuration {
      ipv4_enabled    = false
      private_network = "projects/${var.project_id}/global/networks/default"
    }

    insights_config {
      query_insights_enabled = true
    }
  }
}

resource "google_sql_database" "stalwart" {
  name     = "stalwart"
  instance = google_sql_database_instance.clawmail.name
}

resource "google_sql_user" "stalwart" {
  name     = "stalwart"
  instance = google_sql_database_instance.clawmail.name
  password = var.db_password
}
