$ErrorActionPreference = "Stop"

Write-Host "Building Production Backend Image (node:18-alpine)..." -ForegroundColor Cyan
docker build -t skyking83/prado-chat-backend:latest ./backend

Write-Host "Building Production Frontend Image (Nginx + Vite)..." -ForegroundColor Cyan
docker build -t skyking83/prado-chat-frontend:latest ./frontend

Write-Host "Pushing Backend to Docker Hub (skyking83/prado-chat-backend)..." -ForegroundColor Yellow
docker push skyking83/prado-chat-backend:latest

Write-Host "Pushing Frontend to Docker Hub (skyking83/prado-chat-frontend)..." -ForegroundColor Yellow
docker push skyking83/prado-chat-frontend:latest

Write-Host "Publishing Completed! Images are now live on Docker Hub for TrueNAS!" -ForegroundColor Green
