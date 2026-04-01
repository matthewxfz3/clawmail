# ---------------------------------------------------------------------------
# GCS Bucket — email attachments
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "clawmail_attachments" {
  # Bucket names must be globally unique; scoping by project_id achieves that
  name     = "clawmail-attachments-${var.project_id}"
  location = var.region

  # Enforce uniform, bucket-level IAM (no per-object ACLs)
  uniform_bucket_level_access = true

  # Prevent public access at the bucket level
  public_access_prevention = "enforced"

  # --- Lifecycle rules ---

  # Rule 1: Delete objects older than 90 days
  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age = 90
    }
  }

  # Rule 2: Move objects to NEARLINE storage after 30 days to reduce cost
  lifecycle_rule {
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }
    condition {
      age = 30
    }
  }
}
