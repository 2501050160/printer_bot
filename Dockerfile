FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy source code
COPY . .

# Environment variables
ENV NODE_ENV=production
ENV BACKEND_BASE_URL=https://printer-backend-kgzp.onrender.com
ENV BACKEND_URL=https://printer-backend-kgzp.onrender.com/api/bot/direct-upload

CMD ["node", "whatsapp_bot.js"]
