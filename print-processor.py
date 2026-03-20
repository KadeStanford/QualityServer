#!/usr/bin/env python3
"""
QualityServer Print Job Processor
==================================
Listens to Firebase Realtime Database via REST streaming (SSE) for
instant wake-up signals, then fetches and prints pending jobs.
Falls back to periodic polling as a safety net.

No extra dependencies beyond `requests` (already required).
No service account files, no Firebase SDK, no environment variables
beyond what was already configured.

Run on the shop Mac alongside (or instead of) the old Print Client.

Usage:
    python3 print-processor.py

Configuration:
    Set environment variables or edit the defaults below:
        PRINT_SERVER_URL           - QualityServer URL
        PRINT_API_KEY              - API key (default: ql-print-2024)
        FALLBACK_POLL_INTERVAL     - Seconds between safety-net polls (default: 60)
        DEFAULT_PRINTER            - Fallback CUPS printer if job has none specified
        CLIENT_ID                  - Unique ID for this processor instance
"""

import os
import sys
import time
import json
import base64
import tempfile
import subprocess
import signal as signal_mod
import logging
import threading
from datetime import datetime

try:
    import requests
except ImportError:
    print("ERROR: 'requests' module not found. Install with: pip3 install requests")
    sys.exit(1)

# ─── Configuration ──────────────────────────────────────────────────

SERVER_URL = os.environ.get("PRINT_SERVER_URL", "https://us-central1-qualityexpress-c19f2.cloudfunctions.net/printApi")
API_KEY = os.environ.get("PRINT_API_KEY", "ql-print-2024")
FALLBACK_POLL_INTERVAL = int(os.environ.get("FALLBACK_POLL_INTERVAL", os.environ.get("POLL_INTERVAL", "60")))
DEFAULT_PRINTER = os.environ.get("DEFAULT_PRINTER", "")
CLIENT_ID = os.environ.get("CLIENT_ID", "shop-mac-processor")

FIREBASE_DB_URL = "https://qualityexpress-c19f2-default-rtdb.firebaseio.com"
RTDB_SIGNAL_PATH = "printers/pendingSignal"

# ─── Logging ─────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger("print-processor")

# ─── Graceful Shutdown ──────────────────────────────────────────────

running = True

def shutdown(sig, frame):
    global running
    log.info("Shutting down...")
    running = False

signal_mod.signal(signal_mod.SIGINT, shutdown)
signal_mod.signal(signal_mod.SIGTERM, shutdown)

# ─── RTDB Wake-Up Event ────────────────────────────────────────────

wake_event = threading.Event()

# ─── HTTP Helpers ────────────────────────────────────────────────────

HEADERS = {
    "X-API-Key": API_KEY,
    "Content-Type": "application/json"
}

def api_get(path, params=None):
    """GET request to QualityServer"""
    resp = requests.get(f"{SERVER_URL}{path}", headers=HEADERS, params=params, timeout=15)
    resp.raise_for_status()
    return resp.json()

def api_post(path, data=None):
    """POST request to QualityServer"""
    resp = requests.post(f"{SERVER_URL}{path}", headers=HEADERS, json=data or {}, timeout=15)
    resp.raise_for_status()
    return resp.json()

# ─── CUPS Printing ───────────────────────────────────────────────────

def get_cups_printers():
    """List available CUPS printers"""
    try:
        result = subprocess.run(
            ["lpstat", "-p", "-d"],
            capture_output=True, text=True, timeout=10
        )
        printers = []
        default = None
        for line in result.stdout.splitlines():
            if line.startswith("printer "):
                name = line.split()[1]
                printers.append(name)
            if "system default destination:" in line:
                default = line.split(":")[-1].strip()
        return printers, default
    except Exception as e:
        log.error(f"Failed to list CUPS printers: {e}")
        return [], None

def print_pdf(pdf_path, printer_name, copies=1):
    """
    Send a PDF to a CUPS printer via the `lp` command.
    Returns (success: bool, message: str)
    """
    cmd = ["lp"]
    if printer_name:
        cmd += ["-d", printer_name]
    if copies and copies > 1:
        cmd += ["-n", str(copies)]
    cmd += ["-o", "document-format=application/pdf"]
    cmd.append(pdf_path)

    log.info(f"  Printing: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)

    if result.returncode == 0:
        return True, result.stdout.strip()
    else:
        return False, result.stderr.strip() or f"lp exit code {result.returncode}"

# ─── Job Processing ─────────────────────────────────────────────────

def resolve_printer(job):
    """
    Determine which CUPS printer to use for this job.
    Checks job.printer (system name), falls back to DEFAULT_PRINTER,
    then to system default.
    """
    printer = job.get("printer") or job.get("printerName")
    if printer:
        return printer

    if DEFAULT_PRINTER:
        return DEFAULT_PRINTER

    _, default = get_cups_printers()
    if default:
        log.warning(f"  Job has no printer specified, using system default: {default}")
        return default

    return None

def process_job(job):
    """
    Claim a job, decode the PDF, print it, mark complete or failed.
    """
    job_id = job["id"]
    template = job.get("templateName", "Unknown")
    copies = job.get("copies", 1)

    log.info(f"Processing job {job_id} — {template} (copies: {copies})")

    # 1. Claim the job
    try:
        claim_result = api_post(f"/api/print/jobs/{job_id}/claim", {"clientId": CLIENT_ID})
        log.info(f"  Claimed: {claim_result.get('message')}")
    except requests.exceptions.HTTPError as e:
        if e.response and e.response.status_code == 409:
            log.warning(f"  Job {job_id} already claimed, skipping")
            return
        raise

    # 2. Resolve printer
    printer = resolve_printer(job)
    if not printer:
        fail_msg = "No printer specified and no default printer configured"
        log.error(f"  {fail_msg}")
        api_post(f"/api/print/jobs/{job_id}/fail", {
            "clientId": CLIENT_ID,
            "errorMessage": fail_msg,
            "shouldRetry": False
        })
        return

    log.info(f"  Target printer: {printer}")

    # 3. Decode PDF to temp file
    pdf_data = job.get("pdfData")
    if not pdf_data:
        fail_msg = "Job has no pdfData"
        log.error(f"  {fail_msg}")
        api_post(f"/api/print/jobs/{job_id}/fail", {
            "clientId": CLIENT_ID,
            "errorMessage": fail_msg,
            "shouldRetry": False
        })
        return

    tmp_path = None
    try:
        if pdf_data.startswith("data:"):
            pdf_data = pdf_data.split(",", 1)[1]

        pdf_bytes = base64.b64decode(pdf_data)

        if not pdf_bytes[:5] == b'%PDF-':
            log.error(f"  Decoded data is NOT a valid PDF! First 40 bytes: {pdf_bytes[:40]}")
            log.error(f"  pdfData starts with: {pdf_data[:60]}...")
            api_post(f"/api/print/jobs/{job_id}/fail", {
                "clientId": CLIENT_ID,
                "errorMessage": "Decoded data is not a valid PDF (missing %PDF- header). Possible double-encoding or data corruption.",
                "shouldRetry": False
            })
            return

        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes)
            tmp_path = tmp.name
        log.info(f"  PDF decoded: {len(pdf_bytes)} bytes -> {tmp_path}")

        # 4. Print via CUPS
        success, message = print_pdf(tmp_path, printer, copies)

        if success:
            log.info(f"  Printed successfully: {message}")
            api_post(f"/api/print/jobs/{job_id}/complete", {
                "clientId": CLIENT_ID,
                "printDetails": {
                    "printer": printer,
                    "copies": copies,
                    "cupsMessage": message,
                    "printedAt": datetime.now().isoformat()
                }
            })
        else:
            log.error(f"  Print failed: {message}")
            api_post(f"/api/print/jobs/{job_id}/fail", {
                "clientId": CLIENT_ID,
                "errorMessage": f"CUPS error: {message}",
                "shouldRetry": True
            })

    except Exception as e:
        log.error(f"  Error processing job: {e}")
        try:
            api_post(f"/api/print/jobs/{job_id}/fail", {
                "clientId": CLIENT_ID,
                "errorMessage": str(e),
                "shouldRetry": True
            })
        except Exception:
            pass
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

# ─── Firebase RTDB SSE Listener (zero dependencies beyond requests) ─

rtdb_listener_active = False

def start_rtdb_sse_listener():
    """
    Connect to Firebase RTDB REST streaming API (Server-Sent Events).
    This is the same real-time push mechanism the Firebase SDK uses
    under the hood, but via plain HTTP — no SDK or credentials needed
    when the RTDB rules allow public reads on the signal node.

    Runs on a daemon thread. Automatically reconnects on failure.
    """
    global rtdb_listener_active

    sse_url = f"{FIREBASE_DB_URL}/{RTDB_SIGNAL_PATH}.json"

    def sse_thread():
        global rtdb_listener_active
        reconnect_delay = 2
        first_event = True

        while running:
            try:
                log.info("  SSE: connecting to Firebase RTDB...")
                resp = requests.get(
                    sse_url,
                    headers={"Accept": "text/event-stream"},
                    stream=True,
                    timeout=(10, None)  # 10s connect timeout, no read timeout
                )
                resp.raise_for_status()
                rtdb_listener_active = True
                reconnect_delay = 2
                first_event = True

                for raw_line in resp.iter_lines():
                    if not running:
                        break
                    if not raw_line:
                        continue

                    line = raw_line.decode("utf-8", errors="replace")

                    if not line.startswith("data:"):
                        continue

                    payload = line[5:].strip()
                    if not payload or payload == "null":
                        continue

                    # Skip the initial snapshot (the current value at connect time)
                    if first_event:
                        first_event = False
                        continue

                    try:
                        data = json.loads(payload)
                        if isinstance(data, dict) and data.get("data"):
                            log.info(">>> RTDB wake-up signal received — checking for jobs")
                            wake_event.set()
                    except json.JSONDecodeError:
                        pass

            except requests.exceptions.ConnectionError:
                rtdb_listener_active = False
                if running:
                    log.warning(f"  SSE: connection lost, reconnecting in {reconnect_delay}s...")
            except requests.exceptions.Timeout:
                rtdb_listener_active = False
                if running:
                    log.warning(f"  SSE: connect timeout, retrying in {reconnect_delay}s...")
            except Exception as e:
                rtdb_listener_active = False
                if running:
                    log.warning(f"  SSE: error ({e}), reconnecting in {reconnect_delay}s...")

            if running:
                time.sleep(reconnect_delay)
                reconnect_delay = min(reconnect_delay * 2, 30)

    thread = threading.Thread(target=sse_thread, daemon=True, name="rtdb-sse")
    thread.start()

    # Give it a moment to connect
    time.sleep(1.5)
    return rtdb_listener_active


# ─── Job check loop ────────────────────────────────────────────────

def check_and_process_jobs():
    """Fetch pending jobs from the server and process them. Returns True if jobs were found."""
    data = api_get("/api/print/jobs/pending", {"limit": 5})
    if isinstance(data, dict):
        jobs = data.get("jobs", [])
    elif isinstance(data, list):
        jobs = data
    else:
        jobs = []

    if jobs:
        log.info(f"Found {len(jobs)} pending job(s)")
        for job in jobs:
            if not running:
                break
            process_job(job)
        return True
    return False


# ─── Main Loop ──────────────────────────────────────────────────────

def main():
    log.info("=" * 60)
    log.info("QualityServer Print Job Processor")
    log.info("=" * 60)
    log.info(f"  Server:   {SERVER_URL}")
    log.info(f"  Client:   {CLIENT_ID}")

    if DEFAULT_PRINTER:
        log.info(f"  Default printer: {DEFAULT_PRINTER}")

    # List available printers
    printers, default = get_cups_printers()
    if printers:
        log.info(f"  CUPS printers: {', '.join(printers)}")
        if default:
            log.info(f"  Default CUPS printer: {default}")
    else:
        log.warning("  No CUPS printers detected! Printing will fail.")

    # Test connection to print server
    try:
        api_get("/api/print/stats")
        log.info("  Server connection OK")
    except Exception as e:
        log.error(f"  Server connection failed: {e}")
        log.error("  Check PRINT_SERVER_URL and PRINT_API_KEY")
        sys.exit(1)

    # Start RTDB SSE listener for instant wake-up
    has_rtdb = start_rtdb_sse_listener()

    if has_rtdb:
        log.info("")
        log.info("Listening for print jobs via Firebase RTDB (instant)")
        log.info(f"Safety-net poll every {FALLBACK_POLL_INTERVAL}s")
    else:
        log.info("")
        log.info("RTDB stream not connected — using periodic polling")
        log.info(f"Poll interval: {FALLBACK_POLL_INTERVAL}s (Ctrl+C to stop)")
        log.info("(RTDB will keep trying to reconnect in background)")

    log.info("")

    consecutive_errors = 0

    while running:
        try:
            found = check_and_process_jobs()
            if found:
                consecutive_errors = 0
                continue
            else:
                consecutive_errors = 0

        except requests.exceptions.ConnectionError:
            consecutive_errors += 1
            log.warning(f"Connection error (attempt {consecutive_errors})")
        except requests.exceptions.Timeout:
            consecutive_errors += 1
            log.warning(f"Request timeout (attempt {consecutive_errors})")
        except Exception as e:
            consecutive_errors += 1
            log.error(f"Poll error: {e}")

        if consecutive_errors >= 10:
            log.error("Too many consecutive errors, backing off to 30s")
            time.sleep(30)
            consecutive_errors = 0
        elif running:
            # Block until RTDB signal wakes us OR fallback timeout expires
            wake_event.wait(timeout=FALLBACK_POLL_INTERVAL)
            wake_event.clear()

    log.info("Processor stopped.")

if __name__ == "__main__":
    main()
