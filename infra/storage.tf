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

# Allow Cloud Run MCP service to manage attachment objects
resource "google_storage_bucket_iam_member" "clawmail_attachments_cloudrun" {
  bucket = google_storage_bucket.clawmail_attachments.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.clawmail_mcp_run.email}"
}

# ---------------------------------------------------------------------------
# GCS Bucket — Stalwart email bodies (blobs)
# ---------------------------------------------------------------------------

resource "google_storage_bucket" "stalwart_blobs" {
  name     = "clawmail-stalwart-blobs-${var.project_id}"
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # Email bodies can be archived after 1 year
  lifecycle_rule {
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
    condition {
      age = 365
    }
  }
}

# Allow Stalwart VM service account to read/write email bodies
resource "google_storage_bucket_iam_member" "stalwart_blobs_vm" {
  bucket = google_storage_bucket.stalwart_blobs.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.stalwart_vm.email}"
}
