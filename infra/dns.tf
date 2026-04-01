# ---------------------------------------------------------------------------
# Cloud DNS — managed zone + mail-related records
# ---------------------------------------------------------------------------

resource "google_dns_managed_zone" "clawmail" {
  name        = "clawmail"
  dns_name    = "${var.domain}."
  description = "Public DNS zone for Clawmail (${var.domain})"
  visibility  = "public"
}

# ---------------------------------------------------------------------------
# A record: stalwart.<domain> → static IP
# ---------------------------------------------------------------------------

resource "google_dns_record_set" "stalwart_a" {
  name         = "stalwart.${var.domain}."
  managed_zone = google_dns_managed_zone.clawmail.name
  type         = "A"
  ttl          = 300

  rrdatas = [google_compute_address.stalwart.address]
}

# ---------------------------------------------------------------------------
# MX record: <domain> → stalwart.<domain> (priority 10)
# ---------------------------------------------------------------------------

resource "google_dns_record_set" "mx" {
  name         = "${var.domain}."
  managed_zone = google_dns_managed_zone.clawmail.name
  type         = "MX"
  ttl          = 300

  rrdatas = ["10 stalwart.${var.domain}."]
}

# ---------------------------------------------------------------------------
# SPF TXT record
# Authorises Mailgun relays and the Stalwart static IP as sending sources.
# ~all = softfail for unrecognised senders (adjust to -all once confident).
# ---------------------------------------------------------------------------

resource "google_dns_record_set" "spf" {
  name         = "${var.domain}."
  managed_zone = google_dns_managed_zone.clawmail.name
  type         = "TXT"
  ttl          = 300

  rrdatas = [
    "\"v=spf1 include:mailgun.org ip4:${google_compute_address.stalwart.address} ~all\""
  ]
}

# ---------------------------------------------------------------------------
# DMARC TXT record
# Policy: quarantine. Aggregate reports sent to dmarc@<domain>.
# ---------------------------------------------------------------------------

resource "google_dns_record_set" "dmarc" {
  name         = "_dmarc.${var.domain}."
  managed_zone = google_dns_managed_zone.clawmail.name
  type         = "TXT"
  ttl          = 300

  rrdatas = [
    "\"v=DMARC1; p=quarantine; rua=mailto:dmarc@${var.domain}\""
  ]
}

# ---------------------------------------------------------------------------
# DKIM TXT record — MUST be added manually.
#
# Stalwart generates its DKIM private key on first boot and exposes the
# corresponding public key via its admin interface. Once you have retrieved
# the key material, create a record of the form:
#
#   Name:  <selector>._domainkey.<domain>.
#   Type:  TXT
#   Value: "v=DKIM1; k=rsa; p=<base64-public-key>"
#
# You can then import it into this state with:
#   terraform import google_dns_record_set.dkim \
#     "<zone-name>/<selector>._domainkey.<domain>./TXT"
#
# or simply manage it outside Terraform if you prefer.
# ---------------------------------------------------------------------------
