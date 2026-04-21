FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/
RUN pnpm install
COPY . .
RUN npx prisma generate
EXPOSE 5000
RUN pnpm build
CMD ["sh", "-c", "npx prisma migrate deploy && pnpm start"]
