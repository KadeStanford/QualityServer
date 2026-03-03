#!/usr/bin/env python3
"""
QualityServer Print Job Processor
==================================
Polls QualityServer for pending print jobs, claims them,
prints PDFs via CUPS (lp command), and marks them complete.

Run on the shop Mac alongside (or instead of) the old Print Client.

Usage:
    python3 print-processor.py

Configuration:
    Set environment variables or edit the defaults below:
        PRINT_SERVER_URL  - QualityServer URL (default: https://main.d28unxcojzjqgm.amplifyapp.com)
        PRINT_API_KEY     - API key (default: ql-print-2024)
        POLL_INTERVAL     - Seconds between polls (default: 5)
        DEFAULT_PRINTER   - Fallback CUPS printer if job has none specified
        CLIENT_ID         - Unique ID for this processor instance
"""

import os
import sys
import time
import json
import base64
import tempfile
import subprocess
import signal
import logging
from datetime import datetime

try:
    import requests
except ImportError:
    print("ERROR: 'requests' module not found. Install with: pip3 install requests")
    sys.exit(1)

# ─── Configuration ──────────────────────────────────────────────────

SERVER_URL = os.environ.get("PRINT_SERVER_URL", "https://main.d28unxcojzjqgm.amplifyapp.com")
API_KEY = os.environ.get("PRINT_API_KEY", "ql-print-2024")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "5"))
DEFAULT_PRINTER = os.environ.get("DEFAULT_PRINTER", "")
CLIENT_ID = os.environ.get("CLIENT_ID", "shop-mac-processor")

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

signal.signal(signal.SIGINT, shutdown)
signal.signal(signal.SIGTERM, shutdown)

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
        pdf_bytes = base64.b64decode(pdf_data)
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes)
            tmp_path = tmp.name
        log.info(f"  PDF decoded: {len(pdf_bytes)} bytes → {tmp_path}")

        # 4. Print via CUPS
        success, message = print_pdf(tmp_path, printer, copies)

        if success:
            # 5a. Mark complete
            log.info(f"  ✅ Printed successfully: {message}")
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
            # 5b. Mark failed
            log.error(f"  ❌ Print failed: {message}")
            api_post(f"/api/print/jobs/{job_id}/fail", {
                "clientId": CLIENT_ID,
                "errorMessage": f"CUPS error: {message}",
                "shouldRetry": True
            })

    except Exception as e:
        log.error(f"  ❌ Error processing job: {e}")
        try:
            api_post(f"/api/print/jobs/{job_id}/fail", {
                "clientId": CLIENT_ID,
                "errorMessage": str(e),
                "shouldRetry": True
            })
        except Exception:
            pass
    finally:
        # Clean up temp file
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

# ─── Main Poll Loop ─────────────────────────────────────────────────

def main():
    log.info("=" * 60)
    log.info("QualityServer Print Job Processor")
    log.info("=" * 60)
    log.info(f"  Server:   {SERVER_URL}")
    log.info(f"  Client:   {CLIENT_ID}")
    log.info(f"  Interval: {POLL_INTERVAL}s")

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

    # Test connection
    try:
        api_get("/health")
        log.info("  ✅ Server connection OK")
    except Exception as e:
        log.error(f"  ❌ Server connection failed: {e}")
        log.error("  Check PRINT_SERVER_URL and PRINT_API_KEY")
        sys.exit(1)

    log.info("")
    log.info("Polling for print jobs... (Ctrl+C to stop)")
    log.info("")

    consecutive_errors = 0

    while running:
        try:
            jobs = api_get("/api/print/jobs/pending", {"limit": 5})

            if jobs:
                log.info(f"Found {len(jobs)} pending job(s)")
                for job in jobs:
                    if not running:
                        break
                    process_job(job)
                consecutive_errors = 0
            else:
                consecutive_errors = 0  # No jobs is not an error

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
            time.sleep(POLL_INTERVAL)

    log.info("Processor stopped.")

if __name__ == "__main__":
    main()
