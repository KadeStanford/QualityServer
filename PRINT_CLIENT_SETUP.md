# Print Client → QualityServer Setup

The print processor (`print-processor.py`) runs on the shop Mac. It uses a
**Firebase Realtime Database listener** for instant wake-up when a print job
is queued, with a periodic safety-net poll as backup.

**No new packages, no config files, no environment variables to set.**
It uses the same `requests` library that was already installed.

---

## Updating the Shop Mac

### Only one thing needs to happen:

**Replace `print-processor.py` with the new version from this repo.**

That's it. The new version automatically connects to Firebase RTDB via
REST streaming (SSE) — no SDK, no credentials, no setup. It uses the
same `requests` library that was already installed.

If the processor is currently running, stop it (`Ctrl+C` or kill the
process) and start it again:

```bash
python3 print-processor.py
```

Look for this line in the output:

```
Listening for print jobs via Firebase RTDB (instant)
Safety-net poll every 60s
```

That confirms it's working. Prints will now trigger in ~200ms instead of
waiting up to 5 seconds.

---

## How It Works

```
QL_Test Dashboard                  Firebase Cloud Function           Print Processor (Shop Mac)
     │                                     │                                │
     │ POST /api/print/jobs               │                                │
     │ {pdfData, templateName, printer}   │                                │
     │ ──────────────────────────────────>│                                │
     │                                     │ 1. stores job in Firestore    │
     │                                     │ 2. writes RTDB signal ──────>│ ⚡ INSTANT
     │                                     │    printers/pendingSignal     │ (SSE stream)
     │                                     │                                │
     │                                     │   GET /api/print/jobs/pending │
     │                                     │<────────────────────────────── │ (triggered immediately)
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

**Key difference from old setup:** The print processor no longer polls every
5 seconds. Firebase pushes a wake-up signal the instant a job is created.
A safety-net poll every 60 seconds ensures nothing is ever missed.

---

## Initial Setup (first time only)

If this is the first time setting up the print processor:

### 1. Install Python + requests

```bash
pip3 install requests
```

### 2. Copy `print-processor.py` to the Mac

Place it somewhere convenient, e.g. `~/print-client/print-processor.py`

### 3. Set environment variables (optional — defaults work out of the box)

The defaults point to the Firebase Cloud Function. Only set these if you
need to override:

```bash
export PRINT_SERVER_URL="https://us-central1-qualityexpress-c19f2.cloudfunctions.net/printApi"
export PRINT_API_KEY="ql-print-2024"
export CLIENT_ID="shop-mac-processor"
```

### 4. Run it

```bash
python3 ~/print-client/print-processor.py
```

---

## Verification

1. Start `print-processor.py` and confirm "RTDB listener" messages in the log
2. Send a test print from the QL_Test dashboard
3. The processor log should show `>>> RTDB wake-up signal received` within ~200ms
4. The job should claim, print, and complete almost instantly

---

## Running as a Background Service (Optional)

To keep the processor running after logout, create a LaunchAgent:

```bash
cat > ~/Library/LaunchAgents/com.qualitylube.print-processor.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.qualitylube.print-processor</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>/Users/YOUR_USERNAME/print-client/print-processor.py</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PRINT_SERVER_URL</key>
        <string>https://us-central1-qualityexpress-c19f2.cloudfunctions.net/printApi</string>
        <key>PRINT_API_KEY</key>
        <string>ql-print-2024</string>
        <key>CLIENT_ID</key>
        <string>shop-mac-processor</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/print-processor.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/print-processor.log</string>
</dict>
</plist>
EOF

# Replace YOUR_USERNAME, then load:
launchctl load ~/Library/LaunchAgents/com.qualitylube.print-processor.plist
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Authentication failed" | Check PRINT_API_KEY is `ql-print-2024` |
| "Connection timed out" | Verify internet; try `curl -H "X-API-Key: ql-print-2024" https://us-central1-qualityexpress-c19f2.cloudfunctions.net/printApi/health` |
| Jobs stay pending | Processor not running; check Terminal output |
| "SSE: connection lost" | Normal on network blips; it auto-reconnects. Safety-net poll covers the gap. |
| Printer not found | Run `lpstat -a` to verify CUPS sees the Brother QL-800 |
| "RTDB stream not connected" | Check internet. Processor still works via polling — prints just take up to 60s instead of instant. |
