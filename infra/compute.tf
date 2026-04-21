# ---------------------------------------------------------------------------
# Stalwart Mail Server — Compute Engine VM
# ---------------------------------------------------------------------------

# Persistent disk for primary Stalwart VM (small, only for config/temp data)
# Email bodies stored in GCS, email metadata in PostgreSQL
resource "google_compute_disk" "stalwart_data_primary" {
  name        = "stalwart-data-primary"
  type        = "pd-standard"
  zone        = var.zone
  size        = 20 # 20GB sufficient for config, temp data, and certs
  description = "Stalwart mail server persistent storage (primary) - email bodies in GCS"
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
  for_each  = toset(["stalwart-admin-password", "db-password", "gcs-access-key", "gcs-secret-key"])
  project   = var.project_id
  secret_id = each.key
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.stalwart_vm.email}"
}

# Allow the VM's SA to write logs to Google Cloud Logging
resource "google_project_iam_member" "stalwart_vm_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.stalwart_vm.email}"
}


# Startup script: install Docker + Compose, write docker-compose.yml, start stack
locals {
  stalwart_startup_script = <<-SCRIPT
    #!/bin/bash
    set -euo pipefail

    DOMAIN="${var.domain}"
    PROJECT_ID="${var.project_id}"

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

    # --- Configure Google Cloud Logging for Docker (will be done after Docker install) ---
    echo "[$(date)] Docker logging will be configured after Docker installation"

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

    # --- Configure Google Cloud Logging for Docker ---
    mkdir -p /etc/docker
    cat > /etc/docker/daemon.json <<'DOCKER_CONFIG'
{
  "log-driver": "gcplogs",
  "log-opts": {
    "gcp-log-cmd": "true",
    "gcp-meta-name": "stalwart-primary",
    "gcp-meta-zone": "us-west1-b"
  }
}
DOCKER_CONFIG
    systemctl restart docker
    echo "[$(date)] ✓ Docker logging configured for Google Cloud Logging"

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

    # --- Enable debug logging ---
    echo "[$(date)] === STALWART STARTUP DEBUG LOG START ==="
    echo "[$(date)] DOMAIN=$DOMAIN, PROJECT_ID=$PROJECT_ID"

    # --- Retrieve secrets from Secret Manager (BEFORE config generation) ---
    echo "[$(date)] Retrieving OAuth token from metadata server..."
    GCP_PROJECT_NUMBER=$(curl -sf -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/project/numeric-project-id)
    echo "[$(date)] GCP_PROJECT_NUMBER=$GCP_PROJECT_NUMBER"

    OAUTH_TOKEN=$(curl -sf -H "Metadata-Flavor: Google" \
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
      | grep -o '"access_token":"[^"]*' | cut -d'"' -f4)

    if [ -z "$OAUTH_TOKEN" ]; then
      echo "[$(date)] ERROR: Could not retrieve OAuth token from metadata server"
      exit 1
    fi
    echo "[$(date)] ✓ OAuth token retrieved ($${#OAUTH_TOKEN} chars)"

    # Retrieve secrets using gcloud (more reliable than metadata server)
    echo "[$(date)] Retrieving secrets from Secret Manager..."
    ADMIN_PASSWORD=$(gcloud secrets versions access latest --secret="stalwart-admin-password" --project="$${PROJECT_ID}" 2>/dev/null || echo "")
    echo "[$(date)] stalwart-admin-password: $${#ADMIN_PASSWORD} chars"

    DB_PASSWORD=$(gcloud secrets versions access latest --secret="db-password" --project="$${PROJECT_ID}" 2>/dev/null || echo "")
    echo "[$(date)] db-password: $${#DB_PASSWORD} chars"

    GCS_ACCESS_KEY=$(gcloud secrets versions access latest --secret="gcs-access-key" --project="$${PROJECT_ID}" 2>/dev/null || echo "")
    echo "[$(date)] gcs-access-key: $${#GCS_ACCESS_KEY} chars"

    GCS_SECRET_KEY=$(gcloud secrets versions access latest --secret="gcs-secret-key" --project="$${PROJECT_ID}" 2>/dev/null || echo "")
    echo "[$(date)] gcs-secret-key: $${#GCS_SECRET_KEY} chars"

    if [ -z "$ADMIN_PASSWORD" ]; then
      echo "[$(date)] ERROR: Could not retrieve stalwart-admin-password from Secret Manager"
      exit 1
    fi

    if [ -z "$DB_PASSWORD" ]; then
      echo "[$(date)] ERROR: Could not retrieve db-password from Secret Manager"
      exit 1
    fi

    if [ -z "$GCS_ACCESS_KEY" ] || [ -z "$GCS_SECRET_KEY" ]; then
      echo "[$(date)] WARNING: GCS credentials not found; GCS storage will not work"
    fi
    echo "[$(date)] ✓ All secrets retrieved"

    # --- Create Stalwart config ---
    # TEMPORARY: Delete old config to force recreation with correct fallback-admin
    # TODO: Remove this after auth debugging is complete
    echo "[$(date)] Removing old config.toml for fresh initialization..."
    rm -f /mnt/stalwart-data/stalwart/etc/config.toml

    echo "[$(date)] Checking config.toml..."
    mkdir -p /mnt/stalwart-data/stalwart/etc
    if [ ! -f /mnt/stalwart-data/stalwart/etc/config.toml ]; then
      echo "[$(date)] config.toml not found, creating new one..."
      cat > /mnt/stalwart-data/stalwart/etc/config.toml <<"CONFIG_EOF"
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
blob = "s3"

[store."postgresql"]
type = "postgresql"
host = "10.64.0.3"
port = 5432
database = "stalwart"
user = "stalwart"
password = "DB_PASSWORD_PLACEHOLDER"
timeout = "15s"

[store."postgresql".tls]
enable = false
allow-invalid-certs = false

[store."postgresql".pool]
max-connections = 10

[store."s3"]
type = "s3"
bucket = "clawmail-stalwart-blobs-GCP_PROJECT_ID"
endpoint = "https://storage.googleapis.com"
region = "us-west1"
access-key = "PLACEHOLDER_GCS_ACCESS_KEY"
secret-key = "PLACEHOLDER_GCS_SECRET_KEY"

[authentication.fallback-admin]
user = "admin"
secret = "Stalwart123456789"
CONFIG_EOF
      echo "[$(date)] ✓ config.toml created (with fallback-admin: admin/Stalwart123456789)"

      # Replace credential and configuration placeholders
      echo "[$(date)] Replacing credential and configuration placeholders..."
      sed -i "s|PLACEHOLDER_GCS_ACCESS_KEY|$GCS_ACCESS_KEY|g" /mnt/stalwart-data/stalwart/etc/config.toml
      sed -i "s|PLACEHOLDER_GCS_SECRET_KEY|$GCS_SECRET_KEY|g" /mnt/stalwart-data/stalwart/etc/config.toml
      sed -i "s|DB_PASSWORD_PLACEHOLDER|$DB_PASSWORD|g" /mnt/stalwart-data/stalwart/etc/config.toml
      sed -i "s|GCP_PROJECT_ID|$${PROJECT_ID}|g" /mnt/stalwart-data/stalwart/etc/config.toml
      echo "[$(date)] ✓ All credential and configuration placeholders replaced"

      chmod 644 /mnt/stalwart-data/stalwart/etc/config.toml
    else
      echo "[$(date)] config.toml already exists, preserving (skipping recreation)"
      echo "[$(date)] === CURRENT CONFIG.TOML AUTHENTICATION SECTIONS ==="
      grep -E "^\[authentication|^user|^secret" /mnt/stalwart-data/stalwart/etc/config.toml | sed 's/^/['"$(date)"'] /' || echo "[$(date)] ERROR: Could not read authentication sections"
      echo "[$(date)] === FULL STORAGE CONFIGURATION ==="
      grep -A 15 "^\[storage\]" /mnt/stalwart-data/stalwart/etc/config.toml | sed 's/^/['"$(date)"'] /' || echo "[$(date)] ERROR: Could not read storage config"
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
    echo "[$(date)] Attempting to start Stalwart container..."
    echo "[$(date)] Docker compose file: /opt/stalwart/docker-compose.yml"

    # Verify docker-compose.yml exists
    if [ ! -f /opt/stalwart/docker-compose.yml ]; then
      echo "[$(date)] ERROR: docker-compose.yml not found!"
      exit 1
    fi
    echo "[$(date)] ✓ docker-compose.yml exists"

    # Remove old container if it exists
    if docker ps -a --format '{{.Names}}' | grep -q '^stalwart$'; then
      echo "[$(date)] Removing old Stalwart container..."
      docker compose -f /opt/stalwart/docker-compose.yml down 2>/dev/null || docker rm -f stalwart 2>/dev/null || true
      echo "[$(date)] ✓ Old container removed"
    fi

    MAX_RETRIES=5
    RETRY=0
    while [ $RETRY -lt $MAX_RETRIES ]; do
      echo "[$(date)] Start attempt $((RETRY + 1))/$MAX_RETRIES..."
      if docker compose -f /opt/stalwart/docker-compose.yml up -d; then
        echo "[$(date)] ✅ docker compose up succeeded"
        break
      else
        RETRY=$((RETRY + 1))
        if [ $RETRY -lt $MAX_RETRIES ]; then
          echo "[$(date)] ⚠️  docker compose up failed, retrying in 10 seconds..."
          sleep 10
        fi
      fi
    done

    if [ $RETRY -eq $MAX_RETRIES ]; then
      echo "[$(date)] ❌ ERROR: Failed to start Stalwart after $MAX_RETRIES attempts"
      echo "[$(date)] Docker compose logs:"
      docker logs stalwart 2>&1 || echo "No container logs available"
      echo "[$(date)] Docker daemon logs:"
      journalctl -u docker -n 50 --no-pager 2>&1 || echo "Could not retrieve Docker logs"
      exit 1
    fi

    # --- Verify Stalwart is healthy (startup health check) ---
    echo "[$(date)] Waiting for Stalwart to be ready on port 8080..."
    for i in {1..60}; do
      if curl -sf http://localhost:8080/.well-known/jmap > /dev/null 2>&1; then
        echo "[$(date)] ✅ Stalwart is ready (health check passed on port 8080)"

        # Also test HTTPS listener
        if curl -sk https://localhost:8443/.well-known/jmap > /dev/null 2>&1; then
          echo "[$(date)] ✅ HTTPS listener on 8443 is working"
        else
          echo "[$(date)] ⚠️  HTTPS listener on 8443 not responding (may still be initializing)"
        fi

        # --- Test Management API authentication with detailed logging ---
        echo "[$(date)] Testing Management API authentication..."
        echo "[$(date)] Testing with credentials: admin:Stalwart123456789"

        # Test with verbose output to see HTTP details
        echo "[$(date)] === HTTP REQUEST DETAILS ==="
        MGMT_RESPONSE=$(curl -v -u "admin:Stalwart123456789" http://localhost:8080/api/principal/ 2>&1)
        echo "$MGMT_RESPONSE" | head -30 | sed 's/^/['"$(date)"'] /'

        # Extract just the response body for parsing
        MGMT_BODY=$(echo "$MGMT_RESPONSE" | tail -1)
        echo "[$(date)] === RESPONSE BODY ==="
        echo "[$(date)] $MGMT_BODY"

        # Log database principals to see what exists
        echo "[$(date)] === CHECKING DATABASE STATE ==="
        docker exec stalwart psql -h 10.64.0.3 -U stalwart -d stalwart -c "SELECT name, type FROM principals LIMIT 5;" 2>&1 | sed 's/^/['"$(date)"'] /' || echo "[$(date)] Could not query database"

        if echo "$MGMT_BODY" | grep -q '"status":401'; then
          echo "[$(date)] ⚠️  Management API returned 401: Authentication failed"
        elif echo "$MGMT_BODY" | grep -q '"status":200'; then
          echo "[$(date)] ✅ Management API authenticated successfully"
        else
          echo "[$(date)] Management API unexpected response"
        fi

        # --- Attempt to reset admin password via CLI ---
        echo "[$(date)] Attempting to reset admin password in database via CLI..."
        CLI_RESET_SUCCESS=0
        for path in stalwart-mail /opt/stalwart-mail/bin/stalwart-mail /usr/local/bin/stalwart-mail; do
          echo "[$(date)]   Trying: $path..."
          if docker exec stalwart $path account update admin --password 'Stalwart123456789' 2>&1 | head -5; then
            echo "[$(date)] ✅ Admin password reset successfully with $path"
            CLI_RESET_SUCCESS=1
            break
          fi
        done || true

        # --- Fallback: Delete old admin account after Stalwart initializes database ---
        if [ $CLI_RESET_SUCCESS -eq 0 ]; then
          echo "[$(date)] CLI reset failed; waiting for Stalwart to initialize database schema..."
          apt-get install -y python3-psycopg2 >/dev/null 2>&1

          # Wait for principals table to be created (up to 30 seconds)
          TABLE_READY=0
          for attempt in {1..30}; do
            python3 <<PYTHON_SCRIPT
import psycopg2
try:
    conn = psycopg2.connect(
        host="10.64.0.3",
        database="stalwart",
        user="stalwart",
        password="$DB_PASSWORD"
    )
    cur = conn.cursor()
    cur.execute("SELECT 1 FROM information_schema.tables WHERE table_name = 'principals';")
    result = cur.fetchone()
    cur.close()
    conn.close()
    exit(0 if result else 1)
except:
    exit(1)
PYTHON_SCRIPT
            if [ $? -eq 0 ]; then
              TABLE_READY=1
              break
            fi
            sleep 1
          done

          if [ $TABLE_READY -eq 1 ]; then
            echo "[$(date)] ✅ Database schema ready; attempting to delete old admin account..."
            python3 <<PYTHON_SCRIPT
import psycopg2
from datetime import datetime
try:
    conn = psycopg2.connect(
        host="10.64.0.3",
        database="stalwart",
        user="stalwart",
        password="$DB_PASSWORD"
    )
    cur = conn.cursor()
    cur.execute("DELETE FROM principals WHERE name = 'admin' AND type = 'individual';")
    deleted_rows = cur.rowcount
    conn.commit()
    cur.close()
    conn.close()
    if deleted_rows > 0:
        print(f"[{datetime.now().isoformat()}] ✅ Deleted {deleted_rows} admin account(s)")
except Exception as e:
    print(f"[{datetime.now().isoformat()}] ⚠️  Could not delete: {e}")
PYTHON_SCRIPT

            # Restart container to reload config with fallback-admin active
            echo "[$(date)] Restarting Stalwart container to activate fallback-admin..."
            docker restart stalwart
            sleep 5
          else
            echo "[$(date)] ⚠️  Database schema not ready; fallback-admin will be used if needed"
          fi
        fi

        # --- Create authentication debug script for manual testing ---
        mkdir -p /usr/local/bin
        cat > /usr/local/bin/test-stalwart-auth.sh <<'AUTH_TEST'
#!/bin/bash
echo "=== Stalwart Authentication Debug ===" >&2
echo "[$(date)] Testing Management API..." >&2
curl -v --max-time 5 -u "admin:Stalwart123456789" http://localhost:8080/api/principal/ 2>&1
AUTH_TEST
        chmod +x /usr/local/bin/test-stalwart-auth.sh
        echo "[$(date)] ✓ Debug script created: test-stalwart-auth.sh"

        echo "[$(date)] === STALWART STARTUP DEBUG LOG END ==="
        exit 0
      fi
      echo "[$(date)]   Attempt $i/60: Stalwart not ready yet, retrying..."
      sleep 2
    done
    echo "[$(date)] ❌ ERROR: Stalwart startup health check failed after 120 seconds"
    echo "[$(date)] Docker compose logs:"
    docker logs stalwart 2>&1 | sed 's/^/['"$(date)"'] /'
    echo "[$(date)] Docker daemon status:"
    systemctl status docker 2>&1 | sed 's/^/['"$(date)"'] /' || true
    echo "[$(date)] === STALWART STARTUP DEBUG LOG END (WITH ERRORS) ==="
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
