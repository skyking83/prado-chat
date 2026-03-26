# ---- Production Backend Dockerfile ----
# Uses node:18-alpine for a lean image (~200MB vs ~900MB for node:18)
FROM node:18-alpine

WORKDIR /app

# Install dependencies first (cache-friendly layer)
COPY package*.json ./
RUN npm install --omit=dev

# Install FFmpeg for server-side transcoding
RUN apk add --no-cache ffmpeg

# Copy source code
COPY src/ ./src/

# Ensure data directory exists (SQLite DB lives here)
RUN mkdir -p /app/data

EXPOSE 3001

# Production: use 'npm start' (node directly, no nodemon)
CMD ["npm", "start"]
