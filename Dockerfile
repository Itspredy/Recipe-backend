FROM node:20-slim

# Install Python 3 (required by yt-dlp)
RUN apt-get update && apt-get install -y python3 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

EXPOSE 8787
CMD ["npm", "start"]
