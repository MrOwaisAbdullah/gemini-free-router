FROM node:22-alpine

WORKDIR /app

# Install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source (Node >= 22.18 runs TypeScript directly via type stripping)
COPY src ./src

# Set environment
ENV GFR_HOST=0.0.0.0
ENV GFR_PORT=8787

EXPOSE 8787

# Start the server
CMD ["node", "src/cli.ts"]
