# WHITE-LOTUS malware-scan service: official ClamAV image (clamd + freshclam signature updates) + a tiny HTTPS-fronted adapter.
# Build & run (needs Docker):  docker build -t white-lotus-scanner scanner/ && docker run -e SCAN_TOKEN=... -p 8080:8080 white-lotus-scanner
FROM clamav/clamav:stable
USER root
RUN apk add --no-cache nodejs
COPY server.mjs /opt/scanner/server.mjs
ENV PORT=8080 CLAMD_HOST=127.0.0.1 CLAMD_PORT=3310
EXPOSE 8080
# The base image's entrypoint starts freshclam + clamd; start the adapter alongside it.
CMD ["sh", "-c", "/init & until nc -z 127.0.0.1 3310; do sleep 2; done; exec node /opt/scanner/server.mjs"]
