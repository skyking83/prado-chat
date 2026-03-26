# Prado Chat — TrueNAS Deployment Guide

## Quick Start

1. Copy `docker-compose.yml` to your TrueNAS server (e.g., via SSH or the file manager).
2. Optionally create a `.env` file in the same directory with a strong JWT secret:
   ```
   JWT_SECRET=some-long-random-secret-here
   ```
3. Start the app:
   ```bash
   docker compose up -d
   ```
4. Open `http://<your-truenas-ip>:30099` in your browser.

## Services

| Service  | Port | Description                        |
|----------|------|------------------------------------|
| frontend | 80   | Nginx serving the React SPA        |
| backend  | 3001 | Node.js API + Socket.IO            |

> The frontend proxies `/api` and `/socket.io` requests to the backend internally.
> You only need to expose **port 80** externally.

## Data Persistence

The SQLite database is stored in a named Docker volume `prado-chat-data`.
To find its location on TrueNAS:
```bash
docker volume inspect prado-chat-data
```

**To back up** the database:
```bash
docker run --rm -v prado-chat-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/prado-chat-backup.tar.gz -C /data .
```

## Updating to Latest Version

```bash
docker compose pull
docker compose up -d
```

## Building & Publishing (Windows, from source)

From the project root on your dev machine:
```powershell
.\publish.ps1
```
This builds both images and pushes them to Docker Hub as `skyking83/prado-chat-*`.

## Port Forwarding / Reverse Proxy

For external access, point your reverse proxy (e.g., Nginx Proxy Manager on TrueNAS) at:
- `http://prado-chat:80` → your domain

No changes needed to the containers themselves.
