# ---------------------------------------------------------------------------
# Google Memorystore for Redis — distributed caching and rate limiting
# ---------------------------------------------------------------------------

# Redis instance for distributed idempotency cache and rate limiting
# Enables Cloud Run to scale safely to zero without losing request state
resource "google_redis_instance" "clawmail_cache" {
  depends_on = [google_project_service.redis]

  name           = "clawmail-cache"
  memory_size_gb = 1 # 1 GB sufficient for caches; upgrade if needed
  tier           = "BASIC"
  region         = var.region

  # Redis 7.x for better performance and newer features
  redis_version = "7.2"

  # Allow connections from Cloud Run and Stalwart VM via VPC
  authorized_network = "default"

  # For high availability, use STANDARD tier and enable replication
  # For now, BASIC tier is cost-effective for staging environments

  # Persistence disabled for now (cache only, not for durable storage)
  persistence_config {
    persistence_mode = "DISABLED"
  }

  labels = {
    app = "clawmail"
  }
}

# Output the Redis connection string for Cloud Run
output "redis_connection_string" {
  description = "Redis connection string for Cloud Run (redis://HOST:PORT)"
  value       = "redis://${google_redis_instance.clawmail_cache.host}:${google_redis_instance.clawmail_cache.port}"
}
