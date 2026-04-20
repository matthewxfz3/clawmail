# ---------------------------------------------------------------------------
# Stalwart Mail Server — Compute Engine VM
# ---------------------------------------------------------------------------

# Persistent disk for primary Stalwart VM
resource "google_compute_disk" "stalwart_data_primary" {
  name        = "stalwart-data-primary"
  type        = "pd-standard"
  zone        = var.zone
  size        = 100 # 100GB for mail data
  description = "Stalwart mail server persistent storage (primary)"
}

# Persistent disk for secondary Stalwart VM (for HA failover)
resource "google_compute_disk" "stalwart_data_secondary" {
  name        = "stalwart-data-secondary"
  type        = "pd-standard"
  zone        = var.zone_secondary
  size        = 100 # 100GB for mail data
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

# Allow the VM's SA to read only the specific secrets it needs (least privilege)
resource "google_secret_manager_secret_iam_member" "stalwart_vm_secrets" {
  for_each  = toset(["stalwart-admin-password", "db-password"])
  project   = var.project_id
  secret_id = google_secret_manager_secret.secrets[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.stalwart_vm.email}"
}

# Startup script: install Docker + Compose, write docker-compose.yml, start stack
locals {
  stalwart_startup_script = <<-SCRIPT
    #!/bin/bash
    set -euo pipefail

    DOMAIN="${var.domain}"

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

    # Mount the disk (skip if already mounted)
    echo "Mounting persistent disk..."
    if ! mountpoint -q /mnt/stalwart-data; then
      sudo mount "$${DISK}" /mnt/stalwart-data
      sudo chmod 755 /mnt/stalwart-data
    else
      echo "Persistent disk already mounted at /mnt/stalwart-data"
    fi

    # Add to fstab for persistent mounting
    DISK_UUID=$(blkid -s UUID -o value "$${DISK}")
    if ! grep -q "$${DISK_UUID}" /etc/fstab; then
      echo "UUID=$${DISK_UUID} /mnt/stalwart-data ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab
    fi

    # --- Install Docker and gcloud CLI ---
    # Fix any interrupted dpkg state
    if [ -f /var/lib/apt/lists/lock ]; then
      sudo rm -f /var/lib/apt/lists/lock
    fi
    sudo dpkg --configure -a 2>/dev/null || true

    apt-get update -y
    apt-get install -y ca-certificates curl gnupg lsb-release
    install -m 0755 -d /etc/apt/keyrings
    # Remove old Docker GPG key if it exists to avoid conflicts
    rm -f /etc/apt/keyrings/docker.gpg
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --no-tty --batch --dearmor -o /etc/apt/keyrings/docker.gpg
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

    # Blob store directory (filesystem backend)
    mkdir -p /mnt/stalwart-data/stalwart/blobs
    chmod 755 /mnt/stalwart-data/stalwart/blobs

    # --- Generate self-signed TLS certificates for JMAP secure listener ---
    mkdir -p /mnt/stalwart-data/stalwart/etc/certificates
    openssl req -x509 -newkey rsa:2048 -keyout /mnt/stalwart-data/stalwart/etc/certificates/server.key \
      -out /mnt/stalwart-data/stalwart/etc/certificates/server.crt -days 3650 -nodes \
      -subj "/CN=$${DOMAIN:-localhost}" 2>/dev/null || true
    chmod 600 /mnt/stalwart-data/stalwart/etc/certificates/server.key
    chmod 644 /mnt/stalwart-data/stalwart/etc/certificates/server.crt

    # --- Create Stalwart config (first boot only) ---
    # Do NOT overwrite on every reboot; preserve any admin/UI changes.
    mkdir -p /mnt/stalwart-data/stalwart/etc
    if [ ! -f /mnt/stalwart-data/stalwart/etc/config.toml ]; then
      cat > /mnt/stalwart-data/stalwart/etc/config.toml <<CONFIG_EOF
[server]
hostname = "$${DOMAIN}"

[[server.listener]]
id = "smtp"
bind = ["0.0.0.0:25"]
protocol = "smtp"

[[server.listener]]
id = "imap"
bind = ["0.0.0.0:143"]
protocol = "imap"

[[server.listener]]
id = "jmap"
bind = ["0.0.0.0:8080"]
protocol = "http"

[[server.listener]]
id = "jmap-secure"
bind = ["0.0.0.0:8443"]
protocol = "http"
tls.implicit = true
tls.certificate = "/opt/stalwart-mail/etc/certificates/server.crt"
tls.private-key = "/opt/stalwart-mail/etc/certificates/server.key"

[directory."internal"]
type = "internal"

[storage]
data = "postgresql"
blob = "filesystem"

[store."postgresql"]
type = "postgresql"
host = "10.64.0.3"
port = 5432
database = "stalwart"
user = "stalwart"
password = "745a401b85de13dd4782c5dc919cb61716dbbc90"
timeout = "15s"

[store."postgresql".tls]
enable = false
allow-invalid-certs = false

[store."postgresql".pool]
max-connections = 10

[store."filesystem"]
type = "fs"
path = "/opt/stalwart-mail/blobs"
depth = 2

[authentication.fallback-admin]
user = "admin"
secret = "Stalwart123456789"

[jmap.request-limiter]
rate = "1000/1m"

[api]
enable = true

[api.rate-limiter]
rate = "1000/1m"
CONFIG_EOF
      chmod 644 /mnt/stalwart-data/stalwart/etc/config.toml
    fi

    # --- Retrieve secrets from Secret Manager ---
    GCP_PROJECT_NUMBER=$(curl -sf -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/project/numeric-project-id)

    OAUTH_TOKEN=$(curl -sf -H "Metadata-Flavor: Google" \
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
      | grep -o '"access_token":"[^"]*' | cut -d'"' -f4)

    if [ -z "$OAUTH_TOKEN" ]; then
      echo "ERROR: Could not retrieve OAuth token from metadata server"
      exit 1
    fi

    fetch_secret () {
      local name="$1"
      local resp
      resp=$(curl -sf "https://secretmanager.googleapis.com/v1/projects/$GCP_PROJECT_NUMBER/secrets/$name/versions/latest:access" \
        -H "Authorization: Bearer $OAUTH_TOKEN" 2>/dev/null || echo "")
      echo "$resp" | grep '"data"' | sed 's/.*"data": "\([^"]*\)".*/\1/' | base64 -d 2>/dev/null || true
    }

    ADMIN_PASSWORD=$(fetch_secret "stalwart-admin-password")
    DB_PASSWORD=$(fetch_secret "db-password")

    if [ -z "$ADMIN_PASSWORD" ]; then
      echo "ERROR: Could not retrieve stalwart-admin-password from Secret Manager"
      exit 1
    fi
    if [ -z "$DB_PASSWORD" ]; then
      echo "ERROR: Could not retrieve db-password from Secret Manager"
      exit 1
    fi

    # --- Define Stalwart environment variables ---
    export STALWART_PG_HOST="10.64.0.3"
    export STALWART_PG_DATABASE="stalwart"
    export STALWART_PG_USER="stalwart"
    export STALWART_PG_PASSWORD="$DB_PASSWORD"
    export STALWART_FS_PATH="/opt/stalwart-mail/blobs"
    export STALWART_ADMIN_SECRET="$ADMIN_PASSWORD"

    # --- Write Stalwart docker-compose.yml ---
    mkdir -p /opt/stalwart
    cat > /opt/stalwart/docker-compose.yml <<'EOF'
version: "3.9"
services:
  stalwart:
    image: stalwartlabs/stalwart:${var.stalwart_image_tag}
    container_name: stalwart
    restart: unless-stopped
    ports:
      - "25:25"    # SMTP
      - "143:143"  # IMAP
      - "993:993"  # IMAPS
      - "8080:8080"   # JMAP / management API (HTTP)
      - "8443:8443"   # JMAP / management API (HTTPS)
    volumes:
      # Bind mount to persistent disk (survives VM restart)
      - /mnt/stalwart-data/stalwart:/opt/stalwart-mail
      # TLS certificates for secure JMAP listener (8443)
      - /mnt/stalwart-data/stalwart/etc/certificates:/opt/stalwart-mail/etc/certificates:ro
    env_file:
      - /opt/stalwart/.stalwart.env
    environment:
      - STALWART_CONFIG=/opt/stalwart-mail/etc/config.toml
EOF

    # Restricted env file (avoid embedding secrets in docker-compose.yml)
    cat > /opt/stalwart/.stalwart.env <<EOF_ENV
DOMAIN=$DOMAIN
STALWART_ADMIN_SECRET=$ADMIN_PASSWORD
STALWART_PG_HOST=10.64.0.3
STALWART_PG_DATABASE=stalwart
STALWART_PG_USER=stalwart
STALWART_PG_PASSWORD=$DB_PASSWORD
STALWART_FS_PATH=/opt/stalwart-mail/blobs
EOF_ENV
    chmod 600 /opt/stalwart/.stalwart.env

    # --- Start the stack with retries ---
    echo "Attempting to start Stalwart container..."

    # Remove old container if it exists
    if docker ps -a --format '{{.Names}}' | grep -q '^stalwart$'; then
      echo "Removing old Stalwart container..."
      docker compose -f /opt/stalwart/docker-compose.yml down 2>/dev/null || docker rm -f stalwart 2>/dev/null || true
    fi

    MAX_RETRIES=5
    RETRY=0
    while [ $RETRY -lt $MAX_RETRIES ]; do
      echo "Start attempt $((RETRY + 1))/$MAX_RETRIES..."
      if docker compose -f /opt/stalwart/docker-compose.yml up -d; then
        echo "✅ docker compose up succeeded"
        break
      else
        RETRY=$((RETRY + 1))
        if [ $RETRY -lt $MAX_RETRIES ]; then
          echo "⚠️  docker compose up failed, retrying in 10 seconds..."
          sleep 10
        fi
      fi
    done

    if [ $RETRY -eq $MAX_RETRIES ]; then
      echo "❌ ERROR: Failed to start Stalwart after $MAX_RETRIES attempts"
      echo "Docker compose logs:"
      docker logs stalwart 2>&1 || echo "No container logs available"
      echo "Docker daemon logs:"
      journalctl -u docker -n 50 --no-pager 2>&1 || echo "Could not retrieve Docker logs"
      exit 1
    fi

    # --- Verify Stalwart is healthy (startup health check) ---
    echo "Waiting for Stalwart to be ready..."
    for i in {1..60}; do
      if curl -sf http://localhost:8080/.well-known/jmap > /dev/null 2>&1; then
        echo "✅ Stalwart is ready (health check passed on port 8080)"
        # Also test HTTPS listener
        if curl -sk https://localhost:8443/.well-known/jmap > /dev/null 2>&1; then
          echo "✅ HTTPS listener on 8443 is working"
        else
          echo "⚠️  HTTPS listener on 8443 not responding (may still be initializing)"
        fi
        exit 0
      fi
      echo "  Attempt $i/60: Stalwart not ready yet, retrying..."
      sleep 2
    done
    echo "❌ ERROR: Stalwart startup health check failed after 120 seconds"
    echo "Docker compose logs:"
    docker logs stalwart 2>&1
    echo "Docker daemon status:"
    systemctl status docker 2>&1 || true
    exit 1
  SCRIPT
}

resource "google_compute_instance" "stalwart_primary" {
  name         = "stalwart-primary"
  machine_type = "e2-medium"
  zone         = var.zone

  tags = ["stalwart", "v2"]

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
    email  = google_service_account.stalwart_vm.email
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
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
    email  = google_service_account.stalwart_vm.email
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
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

# JMAP / management API — VPC-internal only (port 8080, 8000)
resource "google_compute_firewall" "stalwart_internal" {
  name    = "stalwart-internal"
  network = "default"

  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = ["8000", "8080"]
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
