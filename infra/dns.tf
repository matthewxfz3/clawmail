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

  rrdatas = [google_compute_address.stalwart_primary.address]
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
    "\"v=spf1 include:sendgrid.net ip4:${google_compute_address.stalwart_primary.address} ~all\""
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

# ---------------------------------------------------------------------------
# Additional domains from ALLOWED_DOMAINS variable
# ---------------------------------------------------------------------------
# The following resources are conditionally created for each additional domain.
# Currently configured for: fridayx.me
#
# To add more domains, update the allowed_domains Terraform variable with a
# comma-separated list (e.g., "fridayx.me,another-domain.com").
# ---------------------------------------------------------------------------

# Managed zone for fridayx.me
resource "google_dns_managed_zone" "secondary" {
  count       = var.allowed_domains != "" ? 1 : 0
  name        = "fridayx-me"
  dns_name    = "fridayx.me."
  description = "Public DNS zone for secondary mail domain (fridayx.me)"
  visibility  = "public"
}

# A record: stalwart.fridayx.me → same static IP as primary domain
resource "google_dns_record_set" "secondary_stalwart_a" {
  count        = var.allowed_domains != "" ? 1 : 0
  name         = "stalwart.fridayx.me."
  managed_zone = google_dns_managed_zone.secondary[0].name
  type         = "A"
  ttl          = 300

  rrdatas = [google_compute_address.stalwart_primary.address]
}

# MX record: fridayx.me → stalwart.fridayx.me (priority 10)
resource "google_dns_record_set" "secondary_mx" {
  count        = var.allowed_domains != "" ? 1 : 0
  name         = "fridayx.me."
  managed_zone = google_dns_managed_zone.secondary[0].name
  type         = "MX"
  ttl          = 300

  rrdatas = ["10 stalwart.fridayx.me."]
}

# SPF TXT record for fridayx.me
# Authorises Mailgun relays and the Stalwart static IP as sending sources.
# ~all = softfail for unrecognised senders (adjust to -all once confident).
resource "google_dns_record_set" "secondary_spf" {
  count        = var.allowed_domains != "" ? 1 : 0
  name         = "fridayx.me."
  managed_zone = google_dns_managed_zone.secondary[0].name
  type         = "TXT"
  ttl          = 300

  rrdatas = [
    "\"v=spf1 include:sendgrid.net ip4:${google_compute_address.stalwart_primary.address} ~all\""
  ]
}

# DMARC TXT record for fridayx.me
# Policy: quarantine. Aggregate reports sent to dmarc@fridayx.me.
resource "google_dns_record_set" "secondary_dmarc" {
  count        = var.allowed_domains != "" ? 1 : 0
  name         = "_dmarc.fridayx.me."
  managed_zone = google_dns_managed_zone.secondary[0].name
  type         = "TXT"
  ttl          = 300

  rrdatas = [
    "\"v=DMARC1; p=quarantine; rua=mailto:dmarc@fridayx.me\""
  ]
}

# DKIM TXT record for fridayx.me — MUST be added manually.
#
# Stalwart generates DKIM public keys per domain. Retrieve the key for fridayx.me
# via the Stalwart admin interface, then create a record of the form:
#
#   Name:  <selector>._domainkey.fridayx.me.
#   Type:  TXT
#   Value: "v=DKIM1; k=rsa; p=<base64-public-key>"
#
# You can then import it into this state with:
#   terraform import google_dns_record_set.secondary_dkim \
#     "fridayx-me/<selector>._domainkey.fridayx.me./TXT"
#
# or simply manage it outside Terraform if you prefer.

# ---------------------------------------------------------------------------
# friday3.com — additional mail domain
# ---------------------------------------------------------------------------

resource "google_dns_managed_zone" "friday3" {
  name        = "friday3-com"
  dns_name    = "friday3.com."
  description = "Public DNS zone for mail domain (friday3.com)"
  visibility  = "public"

  dnssec_config {
    state = "on"
    default_key_specs {
      algorithm  = "rsasha256"
      key_length = 2048
      key_type   = "keySigning"
    }
    default_key_specs {
      algorithm  = "rsasha256"
      key_length = 1024
      key_type   = "zoneSigning"
    }
    non_existence = "nsec3"
  }
}

# A record: stalwart.friday3.com → same static IP as primary domain
resource "google_dns_record_set" "friday3_stalwart_a" {
  name         = "stalwart.friday3.com."
  managed_zone = google_dns_managed_zone.friday3.name
  type         = "A"
  ttl          = 300

  rrdatas = [google_compute_address.stalwart_primary.address]
}

# MX record: friday3.com → stalwart.friday3.com (priority 10)
resource "google_dns_record_set" "friday3_mx" {
  name         = "friday3.com."
  managed_zone = google_dns_managed_zone.friday3.name
  type         = "MX"
  ttl          = 300

  rrdatas = ["10 stalwart.friday3.com."]
}

# SPF TXT record for friday3.com
resource "google_dns_record_set" "friday3_spf" {
  name         = "friday3.com."
  managed_zone = google_dns_managed_zone.friday3.name
  type         = "TXT"
  ttl          = 300

  rrdatas = [
    "\"v=spf1 include:sendgrid.net ip4:${google_compute_address.stalwart_primary.address} ~all\""
  ]
}

# DMARC TXT record for friday3.com
resource "google_dns_record_set" "friday3_dmarc" {
  name         = "_dmarc.friday3.com."
  managed_zone = google_dns_managed_zone.friday3.name
  type         = "TXT"
  ttl          = 300

  rrdatas = [
    "\"v=DMARC1; p=quarantine; rua=mailto:dmarc@friday3.com\""
  ]
}

# DKIM TXT record for friday3.com — MUST be added manually.
#
# Stalwart generates DKIM public keys per domain. Retrieve the key for friday3.com
# via the Stalwart admin interface, then create a record of the form:
#
#   Name:  default._domainkey.friday3.com.
#   Type:  TXT
#   Value: "v=DKIM1; k=rsa; p=<base64-public-key>"
#
# You can then import it into this state with:
#   terraform import google_dns_record_set.friday3_dkim \
#     "friday3-com/default._domainkey.friday3.com./TXT"
