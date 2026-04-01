# Clawmail — C4 Architecture Diagrams

C4 model diagrams rendered in [Mermaid](https://mermaid.js.org/). Three levels: Context → Container → Component.

---

## Level 1 — System Context

Who uses Clawmail and what external systems does it depend on?

```mermaid
C4Context
  title System Context — Clawmail

  Person(agent, "AI Agent", "Any MCP-compatible agent (Claude, GPT, custom)")
  Person(operator, "Operator", "Provisions API keys, manages domain DNS")

  System(clawmail, "Clawmail", "MCP service exposing email capabilities: create accounts, send/receive mail, manage inboxes")

  System_Ext(mailgun, "Mailgun", "Outbound SMTP relay (port 587). Required because GCP blocks port 25 outbound.")
  System_Ext(gcp, "Google Cloud Platform", "Compute, SQL, Storage, DNS, Secrets, Cloud Run")
  System_Ext(internet_smtp, "Internet (SMTP)", "External mail servers delivering inbound email to Clawmail on port 25")
  System_Ext(mcp_client, "MCP Client / Claude Desktop", "Connects agents to MCP servers via HTTP")

  Rel(agent, mcp_client, "Uses")
  Rel(mcp_client, clawmail, "MCP tool calls", "HTTPS / Streamable HTTP")
  Rel(operator, clawmail, "Provisions keys, configures domain")
  Rel(clawmail, mailgun, "Routes outbound email", "SMTP/STARTTLS port 587")
  Rel(internet_smtp, clawmail, "Delivers inbound email", "SMTP port 25")
  Rel(clawmail, gcp, "Runs on / uses services")
```

---

## Level 2 — Container Diagram

What are the deployable units and how do they communicate?

```mermaid
C4Container
  title Container Diagram — Clawmail

  Person(agent, "AI Agent", "MCP-compatible agent")

  System_Boundary(clawmail, "Clawmail") {

    Container(mcp_server, "MCP Server", "TypeScript / Node.js 22", "Exposes 8 MCP tools over Streamable HTTP. Enforces API key auth and per-key rate limiting. Translates tool calls into Stalwart REST/JMAP calls.")

    Container(stalwart, "Stalwart Mail Server", "Rust (Docker)", "All-in-one SMTP + IMAP + JMAP server. Handles inbound/outbound mail, virtual mailboxes, per-account quotas and send-rate throttling.")

    ContainerDb(postgres, "PostgreSQL 15", "Cloud SQL", "Stores mail index, account directory, JMAP state, message metadata.")

    ContainerDb(gcs, "GCS Bucket", "Google Cloud Storage", "Stores email blob data (attachments, message bodies) via S3-compatible API.")

    Container(secrets, "Secret Manager", "GCP Secret Manager", "Stores Stalwart admin password, Mailgun credentials, DB password, MCP API keys.")

    Container(dns, "Cloud DNS", "GCP Cloud DNS", "Hosts MX, SPF, DKIM, DMARC records for the mail domain.")
  }

  System_Ext(mailgun, "Mailgun", "Outbound SMTP relay")
  System_Ext(internet_smtp, "External SMTP", "Inbound mail senders")
  System_Ext(mcp_client, "MCP Client", "Claude Desktop / custom client")

  Rel(agent, mcp_client, "Uses")
  Rel(mcp_client, mcp_server, "MCP tool calls", "HTTPS POST /mcp (Cloud Run)")

  Rel(mcp_server, stalwart, "Account management", "HTTP REST /api/principal")
  Rel(mcp_server, stalwart, "Mailbox operations", "JMAP over HTTP /jmap")
  Rel(mcp_server, secrets, "Reads credentials at startup", "GCP Secret Manager API")

  Rel(stalwart, postgres, "Reads/writes mail index & accounts", "PostgreSQL TCP 5432")
  Rel(stalwart, gcs, "Reads/writes message blobs", "HTTPS S3-compatible API")
  Rel(stalwart, mailgun, "Routes outbound email", "SMTP STARTTLS port 587")
  Rel(internet_smtp, stalwart, "Delivers inbound email", "SMTP port 25")

  Rel(dns, internet_smtp, "MX record directs inbound mail to Stalwart IP")
```

---

## Level 3 — Component Diagram: MCP Server

What are the internal components of the MCP Server container?

```mermaid
C4Component
  title Component Diagram — MCP Server (TypeScript)

  Container_Ext(stalwart_mgmt, "Stalwart Mgmt API", "REST /api/principal")
  Container_Ext(stalwart_jmap, "Stalwart JMAP API", "HTTP /jmap")
  Container_Ext(mcp_client, "MCP Client", "Streamable HTTP")

  Container_Boundary(mcp_server, "MCP Server") {

    Component(http_layer, "HTTP Entry Point", "Node.js http.createServer", "Handles POST/GET /mcp. Runs API key authentication on every request. Returns 401 if key is missing or invalid.")

    Component(rate_limiter, "Rate Limiter", "In-memory sliding window", "Per (apiKey, tool) sliding window. Limits: create_account 10/hr, send_email 20/min, read ops 200/min.")

    Component(mcp_core, "McpServer", "@modelcontextprotocol/sdk", "Registers 8 tools with Zod schemas. Routes incoming tool calls to the correct handler. Formats results as MCP content blocks.")

    Component(tool_accounts, "accounts.ts", "Tool handlers", "create_account: validates local_part format, checks for duplicates, creates via mgmt client.\ndelete_account: deletes via mgmt client.\nlist_accounts: lists all accounts.")

    Component(tool_mailbox, "mailbox.ts", "Tool handlers", "list_emails: JMAP Email/query + Email/get in one batch.\nread_email: JMAP Email/get with full body.\ndelete_email: JMAP Email/set move-to-Trash.\nsearch_emails: JMAP Email/query with text filter.")

    Component(tool_send, "send.ts", "Tool handler", "send_email: validates from/to addresses, enforces 1 MiB body limit, creates draft via JMAP Email/set, submits via JMAP EmailSubmission/set with onSuccessDestroyEmail.")

    Component(mgmt_client, "stalwart-mgmt.ts", "REST client", "Wraps Stalwart Management REST API with Basic auth. Handles account CRUD and quota management.")

    Component(jmap_client, "jmap.ts", "JMAP client", "Session-cached JMAP client (one session per accountId). Implements Email/query, Email/get, Email/set, EmailSubmission/set, Mailbox/get using batched method calls.")

    Component(config, "config.ts", "Configuration", "Reads env vars (DOMAIN, STALWART_URL, STALWART_ADMIN_PASSWORD, MCP_API_KEYS, etc). Throws on missing required values at startup.")
  }

  Rel(mcp_client, http_layer, "POST /mcp", "Streamable HTTP + X-API-Key header")
  Rel(http_layer, rate_limiter, "Check rate limit before forwarding")
  Rel(http_layer, mcp_core, "Forward authenticated request")
  Rel(mcp_core, tool_accounts, "Route create/delete/list_accounts calls")
  Rel(mcp_core, tool_mailbox, "Route list/read/delete/search_emails calls")
  Rel(mcp_core, tool_send, "Route send_email calls")
  Rel(tool_accounts, mgmt_client, "CRUD account")
  Rel(tool_mailbox, jmap_client, "Query / get / mutate emails")
  Rel(tool_send, jmap_client, "Submit email via JMAP")
  Rel(mgmt_client, stalwart_mgmt, "HTTP REST calls")
  Rel(jmap_client, stalwart_jmap, "JMAP method calls")
  Rel(config, http_layer, "Provides port, api keys")
  Rel(config, mgmt_client, "Provides Stalwart URL + credentials")
  Rel(config, jmap_client, "Provides Stalwart URL + credentials")
```

---

## Level 3 — Component Diagram: Stalwart Mail Server

What are the internal subsystems of the Stalwart container?

```mermaid
C4Component
  title Component Diagram — Stalwart Mail Server

  Container_Ext(internet, "Internet (SMTP)", "External mail senders")
  Container_Ext(mailgun, "Mailgun Relay", "Outbound SMTP")
  Container_Ext(mcp_server, "MCP Server", "Internal caller")
  ContainerDb_Ext(postgres, "PostgreSQL", "Cloud SQL")
  ContainerDb_Ext(gcs, "GCS Bucket", "Blob storage")

  Container_Boundary(stalwart, "Stalwart Mail Server") {

    Component(smtp_in, "SMTP Listener", "Port 25", "Accepts inbound email from the internet. Validates recipients against virtual directory.")

    Component(smtp_sub, "Submission Listener", "Port 587 / STARTTLS", "Accepts outbound submission from MCP server or direct clients. Auth required.")

    Component(imap, "IMAP Listener", "Port 143/993", "Provides IMAP4 access for standard email clients.")

    Component(jmap_api, "JMAP HTTP Listener", "Port 8080", "Serves JMAP Core + Mail + Submission. Also serves Management REST API at /api/.")

    Component(queue, "Outbound Queue", "Delivery manager", "Queues outbound messages, applies per-account throttle (100/hr, concurrency 5). Routes all outbound via Mailgun relay.")

    Component(virt_dir, "Virtual Directory", "SQL-backed", "Stores accounts, passwords, aliases, quotas. No OS users. Backed by PostgreSQL.")

    Component(store, "Mail Store", "Dual backend", "Indexes (metadata, JMAP state) → PostgreSQL. Blobs (bodies, attachments) → GCS via S3 API.")

    Component(spam, "Spam Filter", "Built-in", "Basic spam scoring on inbound messages.")
  }

  Rel(internet, smtp_in, "Delivers mail", "SMTP port 25")
  Rel(smtp_in, spam, "Filter inbound")
  Rel(smtp_in, virt_dir, "Validate recipient")
  Rel(smtp_in, store, "Store accepted message")

  Rel(mcp_server, jmap_api, "JMAP tool calls + account management", "HTTP port 8080")
  Rel(jmap_api, virt_dir, "Auth + account lookup")
  Rel(jmap_api, store, "Read/write mail")
  Rel(jmap_api, queue, "Submit outbound")

  Rel(imap, virt_dir, "Auth")
  Rel(imap, store, "Read mail")

  Rel(queue, mailgun, "Relay outbound", "SMTP STARTTLS port 587")

  Rel(virt_dir, postgres, "Read/write accounts")
  Rel(store, postgres, "Read/write mail index")
  Rel(store, gcs, "Read/write blobs")
```

---

## Deployment View

Where does each container run in GCP?

```mermaid
graph TB
  subgraph GCP["Google Cloud Platform"]
    subgraph CR["Cloud Run (stateless, auto-scale 0→10)"]
      MCP["MCP Server\n(Node.js 22 container)"]
    end

    subgraph CE["Compute Engine VM — e2-medium"]
      STL["Stalwart Mail Server\n(Docker, ports 25/143/587/8080)"]
    end

    IP["Static External IP\n(stalwart.domain)"]
    SQL["Cloud SQL\nPostgreSQL 15"]
    GCS["GCS Bucket\nAttachments / blobs"]
    SM["Secret Manager\nCredentials"]
    DNS["Cloud DNS\nMX / SPF / DKIM / DMARC"]
  end

  subgraph External
    MGNET["Mailgun\nSMTP relay"]
    INET["Internet\nInbound SMTP"]
    AGENT["AI Agent\n(via MCP client)"]
  end

  AGENT -->|"HTTPS /mcp"| MCP
  MCP -->|"REST + JMAP :8080"| STL
  MCP -->|"reads secrets"| SM
  STL --- IP
  STL -->|"PostgreSQL"| SQL
  STL -->|"S3 API"| GCS
  STL -->|"SMTP :587"| MGNET
  INET -->|"SMTP :25"| IP
  DNS -.->|"MX → static IP"| IP
```
