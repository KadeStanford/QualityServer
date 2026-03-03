// ─── PrintClient.js ─────────────────────────────────────────────────
// Drop-in print client for the QL_Test admin dashboard.
// Talks to QualityServer (the standalone print API on AWS).
//
// Usage in dashboard HTML:
//   <script src="assets/js/PrintClient.js"></script>
//   <script>
//     const print = new PrintClient('https://your-server.amazonaws.com');
//     // or with API key:
//     const print = new PrintClient('https://...', { apiKey: 'xxx' });
//   </script>
// ────────────────────────────────────────────────────────────────────

class PrintClient {

  // ── Constructor ────────────────────────────────────────────────────
  constructor(serverUrl, opts = {}) {
    this.serverUrl = (serverUrl || '').replace(/\/+$/, '');
    this.apiKey    = opts.apiKey || localStorage.getItem('printApiKey') || '';
    this.printers  = [];
    this.connected = false;

    // Status element IDs (override if your HTML differs)
    this.statusElId  = opts.statusElId  || 'print-client-status';
    this.printerElId = opts.printerElId || 'printer-select';
  }

  // ── Private: fetch helper ──────────────────────────────────────────
  async _fetch(path, opts = {}) {
    const url = `${this.serverUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {})
    };
    const res = await fetch(url, { ...opts, headers: { ...headers, ...opts.headers } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // ── Connection test ────────────────────────────────────────────────
  async testConnection() {
    try {
      const stats = await this._fetch('/api/print/stats');
      this.connected = stats.status === 'ok';

      // Also refresh printer list
      if (this.connected) {
        this.printers = await this._fetch('/api/print/printers');
      }

      this._updateStatusUI(this.connected, stats);
      this._updatePrinterDropdown();
      return { connected: true, stats, printers: this.printers };
    } catch (err) {
      this.connected = false;
      this._updateStatusUI(false, null, err.message);
      return { connected: false, error: err.message };
    }
  }

  // ── Send a print job ───────────────────────────────────────────────
  //    pdfBytes: Uint8Array from pdf-lib
  //    options: { templateName, printer, printerId, copies, paperSize, labelData }
  async sendJob(pdfBytes, options = {}) {
    const pdfData = this._toBase64(pdfBytes);

    const payload = {
      pdfData,
      templateName: options.templateName || 'Label',
      printer:      options.printer || null,
      printerId:    options.printerId || null,
      copies:       options.copies || 1,
      paperSize:    options.paperSize || 'Brother-QL800',
      labelData:    options.labelData || {}
    };

    const result = await this._fetch('/api/print/jobs', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    return result; // { id, status: 'pending', message }
  }

  // ── Get queue stats ────────────────────────────────────────────────
  async getStats() {
    return this._fetch('/api/print/stats');
  }

  // ── Get job list ───────────────────────────────────────────────────
  async getJobs(status) {
    const qs = status ? `?status=${status}` : '';
    return this._fetch(`/api/print/jobs${qs}`);
  }

  // ── Get printers ───────────────────────────────────────────────────
  async getPrinters() {
    this.printers = await this._fetch('/api/print/printers');
    this._updatePrinterDropdown();
    return this.printers;
  }

  // ── Settings ───────────────────────────────────────────────────────

  setServerUrl(url) {
    this.serverUrl = (url || '').replace(/\/+$/, '');
  }

  setApiKey(key) {
    this.apiKey = key || '';
    localStorage.setItem('printApiKey', this.apiKey);
  }

  getApiKey() {
    return this.apiKey;
  }

  // ── UI helpers (update DOM elements if they exist) ─────────────────

  _updateStatusUI(connected, stats, errorMsg) {
    const el = document.getElementById(this.statusElId);
    if (!el) return;

    if (connected) {
      const q = stats?.queue || {};
      el.innerHTML = `<span style="color:#22c55e">● Connected</span> — `
        + `${q.pending || 0} pending, ${q.printing || 0} printing`;
      el.className = 'print-status connected';
    } else {
      el.innerHTML = `<span style="color:#ef4444">● Disconnected</span>`
        + (errorMsg ? ` — ${errorMsg}` : '');
      el.className = 'print-status disconnected';
    }
  }

  _updatePrinterDropdown() {
    const el = document.getElementById(this.printerElId);
    if (!el) return;

    el.innerHTML = '<option value="">Any printer</option>';
    for (const p of this.printers) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.status})`;
      opt.dataset.systemName = p.systemName;
      el.appendChild(opt);
    }
  }

  // ── Utility ────────────────────────────────────────────────────────

  _toBase64(uint8) {
    if (typeof uint8 === 'string') return uint8; // already base64
    let binary = '';
    for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
    return btoa(binary);
  }
}

// Export for module or global
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PrintClient;
} else {
  window.PrintClient = PrintClient;
}
