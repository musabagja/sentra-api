FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma/
RUN pnpm install
COPY . .
RUN pnpm build
EXPOSE 5000
CMD ["node", "dist/server.js"]
