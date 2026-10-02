# Optional: local malware scanning with ClamAV

WHITE-LOTUS can scan uploads with ClamAV **on this computer** before accepting them. Nothing is sent to an online scanner.

**Simplest: clamd directly**

Install ClamAV (Windows: the official installer from clamav.net; macOS: `brew install clamav`; Linux: your package manager), run `freshclam` once to download signatures, and start `clamd` listening on `127.0.0.1:3310`. Then add this to `settings.env`:

```
MALWARE_SCANNER=clamav
CLAMAV_HOST=127.0.0.1
CLAMAV_PORT=3310
MALWARE_SCAN_REQUIRED=true
```

**Alternative: this adapter in Docker (on this computer)**

`scanner/Dockerfile` bundles clamd plus a tiny HTTP adapter (`server.mjs`).

1. Run it locally:
   ```
   docker build -t wl-scanner scanner
   docker run -p 127.0.0.1:8099:8080 -e SCAN_TOKEN=<random> wl-scanner
   ```
2. Set `MALWARE_SCANNER=http`, `MALWARE_SCAN_URL=http://127.0.0.1:8099/scan` and `MALWARE_SCAN_TOKEN=<same token>`.

ClamAV needs about 1.5–2 GB RAM for its signatures.

**Test:** upload the EICAR test file (<https://www.eicar.org/download-anti-malware-testfile/>). It must be rejected. Without a scanner, files are labelled "Not scanned".
