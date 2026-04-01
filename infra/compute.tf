# ---------------------------------------------------------------------------
# Stalwart Mail Server — Compute Engine VM
# ---------------------------------------------------------------------------

# Static external IP so DNS records remain stable across VM restarts/recreates
resource "google_compute_address" "stalwart" {
  name         = "stalwart"
  address_type = "EXTERNAL"
  region       = var.region
}

# Service account used by the Stalwart VM
resource "google_service_account" "stalwart_vm" {
  account_id   = "stalwart-vm"
  display_name = "Stalwart Mail Server VM"
}

# Allow the VM's SA to access Cloud SQL
resource "google_project_iam_member" "stalwart_vm_cloudsql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.stalwart_vm.email}"
}

# Allow the VM's SA to read secrets from Secret Manager
resource "google_project_iam_member" "stalwart_vm_secretmanager" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.stalwart_vm.email}"
}

# Startup script: install Docker + Compose, write docker-compose.yml, start stack
locals {
  stalwart_startup_script = <<-SCRIPT
    #!/bin/bash
    set -euo pipefail

    # --- Install Docker ---
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg lsb-release
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
      https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

    # --- Write Stalwart docker-compose.yml ---
    mkdir -p /opt/stalwart
    cat > /opt/stalwart/docker-compose.yml <<'EOF'
version: "3.9"
services:
  stalwart:
    image: stalwartlabs/mail-server:latest
    container_name: stalwart
    restart: unless-stopped
    ports:
      - "25:25"    # SMTP
      - "143:143"  # IMAP
      - "993:993"  # IMAPS
      - "8080:8080" # JMAP / management API
    volumes:
      - stalwart_data:/opt/stalwart-mail
    environment:
      - STALWART_CONFIG=/opt/stalwart-mail/etc/config.toml
volumes:
  stalwart_data:
EOF

    # --- Start the stack ---
    docker compose -f /opt/stalwart/docker-compose.yml up -d
  SCRIPT
}

resource "google_compute_instance" "stalwart" {
  name         = "stalwart"
  machine_type = "e2-medium"
  zone         = var.zone

  tags = ["stalwart"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = 50
      type  = "pd-balanced"
    }
  }

  network_interface {
    network = "default"

    access_config {
      # Attach the static external IP
      nat_ip = google_compute_address.stalwart.address
    }
  }

  metadata_startup_script = local.stalwart_startup_script

  service_account {
    email = google_service_account.stalwart_vm.email
    scopes = [
      "https://www.googleapis.com/auth/sqlservice.admin",
      "https://www.googleapis.com/auth/cloud-platform",
    ]
  }
}

# ---------------------------------------------------------------------------
# Firewall rules
# ---------------------------------------------------------------------------

# SMTP ingress — public (port 25)
resource "google_compute_firewall" "stalwart_smtp_in" {
  name    = "stalwart-smtp-in"
  network = "default"

  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = ["25"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["stalwart"]
}

# JMAP / management API — VPC-internal only (port 8080)
resource "google_compute_firewall" "stalwart_internal" {
  name    = "stalwart-internal"
  network = "default"

  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = ["8080"]
  }

  # Only allow traffic originating from within the VPC (RFC-1918 10.x.x.x)
  source_ranges = ["10.0.0.0/8"]
  target_tags   = ["stalwart"]
}

# IMAP / IMAPS ingress — public (ports 143, 993)
resource "google_compute_firewall" "stalwart_imap" {
  name    = "stalwart-imap"
  network = "default"

  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = ["143", "993"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["stalwart"]
}
