# Clawmail Deployment

Terraform-based deployment helpers for Clawmail infrastructure on GCP.

## Quick Start

```bash
# 1. Initialize Terraform (first time only)
./deploy/terraform-init

# 2. Review changes
./deploy/terraform-plan

# 3. Apply changes
./deploy/terraform-apply
```

## Available Commands

### terraform-init
Initialize Terraform for the first time or reset initialization.
```bash
./deploy/terraform-init
```

### terraform-validate
Validate Terraform configuration syntax and formatting.
```bash
./deploy/terraform-validate
```

### terraform-plan
Preview changes before applying them.
```bash
./deploy/terraform-plan

# Skip state locking (useful if lock is stuck)
./deploy/terraform-plan -lock=false
```

### terraform-apply
Apply changes to GCP infrastructure.
```bash
./deploy/terraform-apply

# Auto-approve changes (use carefully)
./deploy/terraform-apply -auto-approve -lock=false
```

### terraform-output
Display current Terraform outputs (URLs, connection strings, etc.)
```bash
# Show all outputs
./deploy/terraform-output

# Show specific output
./deploy/terraform-output cloud_run_url
```

## Configuration

Infrastructure configuration is defined in `infra/terraform.tfvars`:
- GCP project and region settings
- Mail domains (primary + allowed_domains)
- Credentials and API keys
- Docker image references

Edit `infra/terraform.tfvars` to change infrastructure settings, then run:
```bash
./deploy/terraform-plan    # Review changes
./deploy/terraform-apply   # Apply changes
```

## Troubleshooting

**State lock issues:**
```bash
./deploy/terraform-plan -lock=false
./deploy/terraform-apply -auto-approve -lock=false
```

**Check current infrastructure state:**
```bash
./deploy/terraform-output
```

**View detailed plan:**
```bash
./deploy/terraform-plan | less
```
