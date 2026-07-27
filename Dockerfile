FROM node:20

# Install Python 3 and ffmpeg (required by yt-dlp)
RUN apt-get update && apt-get install -y python3 ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 8787
CMD ["node", "src/server.js"]
