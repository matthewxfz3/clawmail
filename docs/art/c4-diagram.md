# Clawmail — C4 Architecture Diagrams

C4 model diagrams rendered in [Mermaid](https://mermaid.js.org/) using `flowchart` syntax. Three levels: Context → Container → Component.

---

## Level 1 — System Context

Who uses Clawmail and what external systems does it depend on?

```mermaid
flowchart TD
  agent(["👤 AI Agent\nMCP-compatible agent\nClaude, GPT, custom"])
  operator(["👤 Operator\nProvisions API keys\nmanages domain DNS"])

  clawmail["🖥️ Clawmail\nMCP email service\nCreate accounts · Send · Receive · Manage inboxes"]

  mailgun(["📨 Mailgun\nOutbound SMTP relay :587\nRequired — GCP blocks port 25 outbound"])
  gcp(["☁️ Google Cloud Platform\nCompute · SQL · Storage\nDNS · Secrets · Cloud Run"])
  inet_smtp(["🌐 Internet SMTP\nExternal mail servers\nDeliver inbound email on port 25"])
  mcp_client(["🔌 MCP Client\nClaude Desktop / custom client\nConnects agents to MCP servers"])

  agent -->|uses| mcp_client
  mcp_client -->|"MCP tool calls\nHTTPS Streamable HTTP"| clawmail
  operator -->|"provisions keys\nconfigures DNS"| clawmail
  clawmail -->|"outbound email\nSMTP STARTTLS :587"| mailgun
  inet_smtp -->|"inbound email\nSMTP :25"| clawmail
  clawmail -->|"runs on"| gcp
```

---

## Level 2 — Container Diagram

What are the deployable units and how do they communicate?

```mermaid
flowchart TD
  agent(["👤 AI Agent"])
  mcp_client(["🔌 MCP Client\nClaude Desktop / custom"])
  mailgun(["📨 Mailgun\nOutbound SMTP relay"])
  inet_smtp(["🌐 External SMTP\nInbound mail senders"])

  subgraph clawmail["☁️ Clawmail — Google Cloud Platform"]
    mcp_server["MCP Server\nTypeScript / Node.js 22\nCloud Run · auto-scale 0→10\n─────────────────\nExposes 8 MCP tools over Streamable HTTP\nAPI key auth · per-key rate limiting\nTranslates calls → Stalwart REST + JMAP"]

    stalwart["Stalwart Mail Server\nRust · Docker\nCompute Engine VM\n─────────────────\nSMTP + IMAP + JMAP all-in-one\nVirtual mailboxes · per-account quotas\nSend-rate throttling"]

    postgres[("PostgreSQL 15\nCloud SQL\n─────────\nMail index · accounts\nJMAP state · metadata")]

    gcs[("GCS Bucket\nGoogle Cloud Storage\n─────────\nEmail blobs\nAttachments via S3 API")]

    secrets["Secret Manager\nGCP\n─────────\nStalwart password\nMailgun creds\nMCP API keys"]

    dns["Cloud DNS\nGCP\n─────────\nMX · SPF · DKIM · DMARC\nrecords for mail domain"]
  end

  agent -->|uses| mcp_client
  mcp_client -->|"MCP tool calls\nHTTPS POST /mcp"| mcp_server

  mcp_server -->|"account management\nHTTP REST /api/principal"| stalwart
  mcp_server -->|"mailbox operations\nJMAP over HTTP /jmap"| stalwart
  mcp_server -->|"reads credentials at startup"| secrets

  stalwart -->|"mail index & accounts\nTCP :5432"| postgres
  stalwart -->|"message blobs\nHTTPS S3-compatible API"| gcs
  stalwart -->|"outbound email\nSMTP STARTTLS :587"| mailgun

  inet_smtp -->|"inbound email\nSMTP :25"| stalwart
  dns -. "MX → Stalwart static IP" .-> stalwart
```

---

## Level 3 — Component Diagram: MCP Server

What are the internal components of the MCP Server?

```mermaid
flowchart TD
  mcp_client(["🔌 MCP Client\nStreamable HTTP"])
  stalwart_mgmt(["Stalwart Mgmt API\nREST /api/principal"])
  stalwart_jmap(["Stalwart JMAP API\nHTTP /jmap"])

  subgraph mcp_server["MCP Server — src/"]
    config["config.ts\n─────────────────\nReads env vars at startup\nDOMAIN · STALWART_URL\nSTALWART_ADMIN_PASSWORD\nMCP_API_KEYS\nThrows on missing required values"]

    http_layer["index.ts · HTTP Entry Point\nNode.js http.createServer\n─────────────────\nPOST /mcp · GET /mcp\nValidates X-API-Key header\nReturns 401 if missing or invalid"]

    rate_limiter["index.ts · Rate Limiter\nIn-memory sliding window\n─────────────────\ncreate_account: 10 / hr\nsend_email: 20 / min\nread ops: 200 / min\nper apiKey × tool key"]

    mcp_core["McpServer\n@modelcontextprotocol/sdk\n─────────────────\nRegisters 8 tools with Zod schemas\nRoutes tool calls to handlers\nFormats results as MCP content blocks"]

    tool_accounts["tools/accounts.ts\n─────────────────\ncreate_account — validate + create\ndelete_account — delete\nlist_accounts — list all"]

    tool_mailbox["tools/mailbox.ts\n─────────────────\nlist_emails — JMAP query + get batch\nread_email — full body\ndelete_email — move to Trash\nsearch_emails — text filter"]

    tool_send["tools/send.ts\n─────────────────\nsend_email — validate addresses\nenforce 1 MiB body limit\nJMAP draft → EmailSubmission"]

    mgmt_client["clients/stalwart-mgmt.ts\nREST client\n─────────────────\nBasic auth header\nAccount CRUD + quota management\nDescriptive errors on HTTP failure"]

    jmap_client["clients/jmap.ts\nJMAP client\n─────────────────\nSession-cached per accountId\nEmail/query · Email/get · Email/set\nEmailSubmission/set · Mailbox/get\nBatched method calls"]
  end

  mcp_client -->|"POST /mcp\nX-API-Key header"| http_layer
  config -->|"port · api keys"| http_layer
  http_layer -->|"check limit"| rate_limiter
  rate_limiter -->|"pass or 429"| mcp_core
  mcp_core -->|"create / delete / list accounts"| tool_accounts
  mcp_core -->|"list / read / delete / search emails"| tool_mailbox
  mcp_core -->|"send email"| tool_send
  tool_accounts --> mgmt_client
  tool_mailbox --> jmap_client
  tool_send --> jmap_client
  config -->|"URL · credentials"| mgmt_client
  config -->|"URL · credentials"| jmap_client
  mgmt_client -->|"HTTP REST"| stalwart_mgmt
  jmap_client -->|"JMAP calls"| stalwart_jmap
```

---

## Level 3 — Component Diagram: Stalwart Mail Server

What are the internal subsystems of Stalwart?

```mermaid
flowchart TD
  internet(["🌐 Internet\nExternal mail senders"])
  mailgun(["📨 Mailgun Relay\nOutbound SMTP"])
  mcp_server_ext(["MCP Server\nInternal caller"])
  postgres_ext[("PostgreSQL\nCloud SQL")]
  gcs_ext[("GCS Bucket\nBlob storage")]

  subgraph stalwart["Stalwart Mail Server"]
    smtp_in["SMTP Listener\nPort 25\n─────────────────\nAccepts inbound email\nValidates recipients\nagainst virtual directory"]

    smtp_sub["Submission Listener\nPort 587 · STARTTLS\n─────────────────\nOutbound submission\nAuth required"]

    imap["IMAP Listener\nPort 143 / 993\n─────────────────\nIMAP4 access\nfor standard email clients"]

    jmap_api["JMAP HTTP Listener\nPort 8080\n─────────────────\nJMAP Core + Mail + Submission\nManagement REST API at /api/"]

    spam["Spam Filter\nBuilt-in\n─────────────────\nBasic spam scoring\non inbound messages"]

    queue["Outbound Queue\nDelivery manager\n─────────────────\n100 msg / hr per account\nconcurrency 5\nRoutes via Mailgun relay"]

    virt_dir["Virtual Directory\nSQL-backed\n─────────────────\nAccounts · passwords\naliases · quotas\nNo OS users"]

    store["Mail Store\nDual backend\n─────────────────\nIndexes → PostgreSQL\nBlobs → GCS via S3 API"]
  end

  internet -->|"SMTP :25"| smtp_in
  smtp_in -->|"score inbound"| spam
  spam -->|"validate recipient"| virt_dir
  spam -->|"store accepted message"| store

  mcp_server_ext -->|"JMAP + mgmt\nHTTP :8080"| jmap_api
  jmap_api -->|"auth + account lookup"| virt_dir
  jmap_api -->|"read / write mail"| store
  jmap_api -->|"submit outbound"| queue

  imap -->|"auth"| virt_dir
  imap -->|"read mail"| store

  smtp_sub -->|"queue outbound"| queue
  queue -->|"relay\nSMTP STARTTLS :587"| mailgun

  virt_dir -->|"read / write accounts"| postgres_ext
  store -->|"mail index"| postgres_ext
  store -->|"blobs"| gcs_ext
```

---

## Deployment View

Where does each container run in GCP?

```mermaid
flowchart TD
  subgraph External["External"]
    AGENT(["👤 AI Agent\nvia MCP client"])
    MGNET(["📨 Mailgun\nSMTP relay"])
    INET(["🌐 Internet\nInbound SMTP"])
  end

  subgraph GCP["☁️ Google Cloud Platform"]
    subgraph CR["Cloud Run — stateless · auto-scale 0 → 10"]
      MCP["MCP Server\nNode.js 22 container\nPOST /mcp · GET /mcp"]
    end

    subgraph CE["Compute Engine VM — e2-medium · Ubuntu 22.04"]
      STL["Stalwart Mail Server\nDocker\nports 25 · 143 · 587 · 8080"]
    end

    IP["🔌 Static External IP\nstalwart.domain"]
    SQL[("Cloud SQL\nPostgreSQL 15\nmail index · accounts")]
    BUCKET[("GCS Bucket\nAttachments · blobs")]
    SM["Secret Manager\nStalwart pw · Mailgun creds\nDB pw · MCP API keys"]
    DNS["Cloud DNS\nMX · SPF · DKIM · DMARC"]
  end

  AGENT -->|"HTTPS /mcp"| MCP
  MCP -->|"REST + JMAP :8080\nVPC internal"| STL
  MCP -->|"reads secrets"| SM
  STL --- IP
  STL -->|"PostgreSQL :5432"| SQL
  STL -->|"S3-compatible API"| BUCKET
  STL -->|"SMTP STARTTLS :587"| MGNET
  INET -->|"SMTP :25"| IP
  DNS -. "MX → static IP" .-> IP
```
