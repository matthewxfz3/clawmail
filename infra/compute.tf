# ---------------------------------------------------------------------------
# Stalwart Mail Server — Compute Engine VM
# ---------------------------------------------------------------------------

# Persistent disk for primary Stalwart VM
resource "google_compute_disk" "stalwart_data_primary" {
  name        = "stalwart-data-primary"
  type        = "pd-standard"
  zone        = var.zone
  size        = 100  # 100GB for mail data
  description = "Stalwart mail server persistent storage (primary)"
}

# Persistent disk for secondary Stalwart VM (for HA failover)
resource "google_compute_disk" "stalwart_data_secondary" {
  name        = "stalwart-data-secondary"
  type        = "pd-standard"
  zone        = var.zone_secondary
  size        = 100  # 100GB for mail data
  description = "Stalwart mail server persistent storage (secondary)"
}

# Static external IPs for primary and secondary Stalwart VMs
resource "google_compute_address" "stalwart_primary" {
  name         = "stalwart-primary"
  address_type = "EXTERNAL"
  region       = var.region
}

resource "google_compute_address" "stalwart_secondary" {
  name         = "stalwart-secondary"
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

    # --- Format and mount persistent disk ---
    # Wait for disk to appear (sdb or sdc depending on device order)
    for i in {1..30}; do
      if [ -e /dev/sdb ]; then
        DISK=/dev/sdb
        break
      elif [ -e /dev/sdc ]; then
        DISK=/dev/sdc
        break
      fi
      sleep 1
    done

    if [ -z "$${DISK:-}" ]; then
      echo "ERROR: Persistent disk not found"
      exit 1
    fi

    # Create mount point
    mkdir -p /mnt/stalwart-data

    # Check if disk is already formatted
    if ! sudo blkid "$${DISK}" 2>/dev/null; then
      echo "Formatting persistent disk $${DISK}..."
      sudo mkfs.ext4 -F "$${DISK}"
    fi

    # Mount the disk
    echo "Mounting persistent disk..."
    sudo mount "$${DISK}" /mnt/stalwart-data
    sudo chmod 755 /mnt/stalwart-data

    # Add to fstab for persistent mounting
    if ! grep -q "$${DISK}" /etc/fstab; then
      echo "$${DISK} /mnt/stalwart-data ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab
    fi

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

    # --- Create Stalwart data directory ---
    mkdir -p /mnt/stalwart-data/stalwart
    chmod 755 /mnt/stalwart-data/stalwart

    # --- Generate self-signed TLS certificates for JMAP secure listener ---
    mkdir -p /mnt/stalwart-data/stalwart/etc/certificates
    openssl req -x509 -newkey rsa:2048 -keyout /mnt/stalwart-data/stalwart/etc/certificates/server.key \
      -out /mnt/stalwart-data/stalwart/etc/certificates/server.crt -days 3650 -nodes \
      -subj "/CN=$${DOMAIN:-localhost}" 2>/dev/null || true
    chmod 600 /mnt/stalwart-data/stalwart/etc/certificates/server.key
    chmod 644 /mnt/stalwart-data/stalwart/etc/certificates/server.crt

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
      # Bind mount to persistent disk (survives VM restart)
      - /mnt/stalwart-data/stalwart:/opt/stalwart-mail
      # TLS certificates for secure JMAP listener (8443)
      - /mnt/stalwart-data/stalwart/etc/certificates:/opt/stalwart-mail/etc/certificates:ro
    environment:
      - STALWART_CONFIG=/opt/stalwart-mail/etc/config.toml
EOF

    # --- Start the stack ---
    docker compose -f /opt/stalwart/docker-compose.yml up -d

    # --- Verify Stalwart is healthy (startup health check) ---
    echo "Waiting for Stalwart to be ready..."
    for i in {1..60}; do
      if curl -sf http://localhost:8080/.well-known/jmap > /dev/null 2>&1; then
        echo "✅ Stalwart is ready (health check passed)"
        exit 0
      fi
      echo "  Attempt $i/60: Stalwart not ready yet, retrying..."
      sleep 2
    done
    echo "❌ ERROR: Stalwart startup health check failed after 120 seconds"
    docker logs stalwart
    exit 1
  SCRIPT
}

resource "google_compute_instance" "stalwart_primary" {
  name         = "stalwart-primary"
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

  # Attach the persistent disk for Stalwart data
  attached_disk {
    source      = google_compute_disk.stalwart_data_primary.id
    device_name = "stalwart-data"
  }

  network_interface {
    network = "default"

    access_config {
      # Attach the static external IP
      nat_ip = google_compute_address.stalwart_primary.address
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

# Secondary Stalwart VM for HA failover (in different zone)
resource "google_compute_instance" "stalwart_secondary" {
  name         = "stalwart-secondary"
  machine_type = "e2-medium"
  zone         = var.zone_secondary

  tags = ["stalwart"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = 50
      type  = "pd-balanced"
    }
  }

  # Attach the persistent disk for Stalwart data
  attached_disk {
    source      = google_compute_disk.stalwart_data_secondary.id
    device_name = "stalwart-data"
  }

  network_interface {
    network = "default"

    access_config {
      # Attach the static external IP
      nat_ip = google_compute_address.stalwart_secondary.address
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
