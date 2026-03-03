#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Install print-processor.py as a macOS launchd service
# Run this on the shop Mac:
#   chmod +x install-service.sh && ./install-service.sh
# ═══════════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROCESSOR="$SCRIPT_DIR/print-processor.py"
PLIST_NAME="com.qualityserver.print-processor"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
LOG_DIR="$HOME/Library/Logs/QualityServer"

# ─── Configuration (edit these) ──────────────────────────────────
SERVER_URL="${PRINT_SERVER_URL:-https://main.d28unxcojzjqgm.amplifyapp.com}"
API_KEY="${PRINT_API_KEY:-ql-print-2024}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
DEFAULT_PRINTER="${DEFAULT_PRINTER:-}"
CLIENT_ID="${CLIENT_ID:-shop-mac-processor}"
# ────────────────────────────────────────────────────────────────

echo "═══════════════════════════════════════════════"
echo " QualityServer Print Processor — Installer"
echo "═══════════════════════════════════════════════"
echo ""
echo "  Script:   $PROCESSOR"
echo "  Server:   $SERVER_URL"
echo "  Client:   $CLIENT_ID"
echo "  Interval: ${POLL_INTERVAL}s"
echo ""

# Ensure requests module is installed
python3 -c "import requests" 2>/dev/null || {
    echo "Installing 'requests' module..."
    pip3 install requests
}

# Make processor executable
chmod +x "$PROCESSOR"

# Create log directory
mkdir -p "$LOG_DIR"

# Unload existing service if present
if launchctl list | grep -q "$PLIST_NAME"; then
    echo "Stopping existing service..."
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# Write launchd plist
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_NAME</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>$PROCESSOR</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$SCRIPT_DIR</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PRINT_SERVER_URL</key>
        <string>$SERVER_URL</string>
        <key>PRINT_API_KEY</key>
        <string>$API_KEY</string>
        <key>POLL_INTERVAL</key>
        <string>$POLL_INTERVAL</string>
        <key>DEFAULT_PRINTER</key>
        <string>$DEFAULT_PRINTER</string>
        <key>CLIENT_ID</key>
        <string>$CLIENT_ID</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>$LOG_DIR/print-processor.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/print-processor-error.log</string>

    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
EOF

echo "Wrote plist: $PLIST_PATH"

# Load service
launchctl load "$PLIST_PATH"

echo ""
echo "✅ Print processor installed and started!"
echo ""
echo "Commands:"
echo "  View logs:    tail -f $LOG_DIR/print-processor.log"
echo "  Stop:         launchctl unload $PLIST_PATH"
echo "  Start:        launchctl load $PLIST_PATH"
echo "  Uninstall:    launchctl unload $PLIST_PATH && rm $PLIST_PATH"
echo ""
