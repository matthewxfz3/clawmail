# ---------------------------------------------------------------------------
# Artifact Registry — Docker repository for the MCP server image
# ---------------------------------------------------------------------------

resource "google_project_service" "artifact_registry" {
  service            = "artifactregistry.googleapis.com"
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "clawmail" {
  depends_on = [google_project_service.artifact_registry]

  location      = var.region
  repository_id = "clawmail"
  description   = "Docker images for the Clawmail MCP server"
  format        = "DOCKER"
}

# Allow the Cloud Run service account to pull images from this registry
resource "google_artifact_registry_repository_iam_member" "cloud_run_reader" {
  location   = google_artifact_registry_repository.clawmail.location
  repository = google_artifact_registry_repository.clawmail.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.clawmail_mcp_run.email}"
}
