FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/
RUN pnpm install
RUN npx prisma generate
COPY . .
EXPOSE 5000
CMD [ "pnpm", "start" ]
