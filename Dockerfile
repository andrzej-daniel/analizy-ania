FROM caddy:2-alpine
COPY portal /srv
CMD ["sh", "-c", "caddy file-server --root /srv --listen :${PORT:-80}"]
