# Print Client → QualityServer Setup

The existing Print Client Electron app at the shop needs **two config changes** to start polling QualityServer instead of the old Inspectionapp.

---

## Step 1: Set the Auth Token

On the shop Mac, open **Terminal** and run:

```bash
# Find where the Print Client writes .auth_token (usually its working directory)
# The token is the same API key QualityServer uses
echo "ql-print-2024" > ~/.auth_token

# Also write it where the app might look (its bundle directory)
APP_DIR="$(find /Applications -name 'Print Client.app' -maxdepth 1 2>/dev/null | head -1)"
if [ -n "$APP_DIR" ]; then
  echo "ql-print-2024" > "$APP_DIR/Contents/Resources/app.asar.unpacked/.auth_token"
fi
```

**Or** do it through the Print Client UI:
1. Open the Print Client dashboard (http://localhost:7010)
2. Go to the **Settings** tab
3. Paste `ql-print-2024` into the **Auth Token** field
4. Click Save

---

## Step 2: Set the Server URL

**Option A — Through the Print Client UI** (easiest):
1. Open http://localhost:7010 in a browser
2. Go to **Settings** → **Server Configuration**
3. Set **Server URL** to: `https://main.d28unxcojzjqgm.amplifyapp.com`
4. Click **Save** → the app sets `USE_DYNAMIC_IP: false` automatically

**Option B — Edit the config file directly**:

```bash
CONFIG_DIR="$HOME/Library/Application Support/Print Client"
mkdir -p "$CONFIG_DIR"

cat > "$CONFIG_DIR/print_client_config.json" << 'EOF'
{
  "PRINT_SERVER": "https://main.d28unxcojzjqgm.amplifyapp.com",
  "USE_DYNAMIC_IP": false,
  "CLIENT_NAME": "Shop-Mac",
  "POLL_INTERVAL": 5,
  "VERIFY_SSL": true
}
EOF
```

---

## Step 3: Restart the Print Client

Quit and relaunch the Print Client app. It will:
1. Connect to QualityServer using the auth token
2. Register its printers
3. Start polling `GET /api/print/jobs/pending` every 5 seconds
4. Claim → decode base64 PDF → print via CUPS → mark complete

---

## Step 4: Enable Auto-Approval (recommended for labels)

By default the Print Client shows a preview and waits for user approval before printing. For labels, you probably want auto-print:

1. Open http://localhost:7010
2. Find the **Auto-Approval** toggle  
3. Enable it — jobs will print automatically as they arrive

---

## How It Works

```
QL_Test Dashboard                   QualityServer (AWS)              Print Client (Shop Mac)
     │                                     │                                │
     │ POST /api/print/jobs               │                                │
     │ {pdfData, templateName, printer}   │                                │
     │ ──────────────────────────────────>│                                │
     │                                     │ stores as "pending"           │
     │                                     │                                │
     │                                     │   GET /api/print/jobs/pending │
     │                                     │<────────────────────────────── │ (every 5s)
     │                                     │ → [{id, pdfData, ...}]        │
     │                                     │ ──────────────────────────────>│
     │                                     │                                │
     │                                     │   POST /jobs/:id/claim        │
     │                                     │<────────────────────────────── │
     │                                     │ status → "printing"           │
     │                                     │                                │
     │                                     │                    b64decode   │
     │                                     │                    → temp.pdf  │
     │                                     │                    lp -d Bro.. │
     │                                     │                    🖨️ printed  │
     │                                     │                                │
     │                                     │   POST /jobs/:id/complete     │
     │                                     │<────────────────────────────── │
     │                                     │ status → "completed"          │
```

---

## Verification

After setup, check the Print Client dashboard at http://localhost:7010:

- **Connection status** should show "Connected" to QualityServer
- **Polling** should show "Active"
- Send a test print from the QL_Test dashboard — it should appear in the Print Client's queue within 5 seconds

From the QL_Test dashboard, the **Print Jobs** tab shows real-time status of all jobs.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Authentication failed" | Check `.auth_token` contains `ql-print-2024` |
| "Connection timed out" | Verify Mac has internet access; try `curl -H "X-API-Key: ql-print-2024" https://main.d28unxcojzjqgm.amplifyapp.com/health` |
| Jobs stay pending | Print Client not running or not polling; check http://localhost:7010 |
| "CORS error" | Print Client uses Python `requests`, not a browser — CORS shouldn't apply. If using browser, check Allowed Origins |
| Printer not found | Run `lpstat -a` on the Mac to verify CUPS sees the Brother QL-800 |
