# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "stalwart_ip" {
  description = "Static external IP address of the Stalwart mail server VM"
  value       = google_compute_address.stalwart.address
}

output "cloud_run_url" {
  description = "URI of the Clawmail MCP Cloud Run service"
  value       = google_cloud_run_v2_service.clawmail_mcp.uri
}

output "cloud_sql_connection_name" {
  description = "Connection name for the Cloud SQL instance (used by Cloud SQL Auth Proxy)"
  value       = google_sql_database_instance.clawmail.connection_name
}

output "gcs_bucket_name" {
  description = "Name of the GCS bucket used for email attachments"
  value       = google_storage_bucket.clawmail_attachments.name
}

output "dns_name_servers" {
  description = "Name servers for the Cloud DNS managed zone — delegate your domain to these"
  value       = google_dns_managed_zone.clawmail.name_servers
}

output "artifact_registry_url" {
  description = "Docker image base URL for the Clawmail MCP server"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/clawmail/mcp-server"
}

output "stalwart_persistent_disk" {
  description = "Persistent disk for Stalwart mail data — survives VM restart"
  value       = google_compute_disk.stalwart_data.name
}
