# ---- Multi-stage Production Frontend Dockerfile ----

# Stage 1: Build the React app
FROM node:18-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .

# Build the static assets. VITE_API_URL is intentionally left empty
# so nginx can proxy /api and /socket.io to the backend on the same host/port.
RUN npm run build

# Stage 2: Serve with nginx (tiny ~25MB image)
FROM nginx:alpine

# Copy built assets
COPY --from=build /app/dist /usr/share/nginx/html

# Copy our custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
