#!/bin/bash
# Generate self-signed TLS certificates for local Stalwart development

CERT_DIR="./certs"
mkdir -p "$CERT_DIR"

if [ -f "$CERT_DIR/server.crt" ] && [ -f "$CERT_DIR/server.key" ]; then
  echo "✅ Certificates already exist in $CERT_DIR"
  exit 0
fi

echo "Generating self-signed TLS certificate for localhost..."
openssl req -x509 -newkey rsa:2048 -keyout "$CERT_DIR/server.key" \
  -out "$CERT_DIR/server.crt" -days 3650 -nodes \
  -subj "/CN=localhost"

if [ $? -eq 0 ]; then
  echo "✅ Generated certificates:"
  echo "  - $CERT_DIR/server.crt"
  echo "  - $CERT_DIR/server.key"
  chmod 600 "$CERT_DIR/server.key"
  chmod 644 "$CERT_DIR/server.crt"
else
  echo "❌ Failed to generate certificates"
  exit 1
fi
