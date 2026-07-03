"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const client_1 = require("../generated/prisma/client");
const provider = (process.env.DATABASE_PROVIDER || "sqlserver").toLowerCase();
const url = process.env.DATABASE_URL;
// Parse Prisma's SQL Server URL format:
// sqlserver://HOST:PORT;database=DB;user=U;password=P;encrypt=true;...
function parseMssqlUrl(rawUrl) {
    const withoutScheme = rawUrl.replace(/^sqlserver:\/\//, "");
    const segments = withoutScheme.split(";");
    const hostPort = segments[0] ?? "";
    const parts = segments.slice(1);
    const colonIdx = hostPort.lastIndexOf(":");
    const server = colonIdx > 0 ? hostPort.slice(0, colonIdx) : hostPort;
    const port = colonIdx > 0 ? parseInt(hostPort.slice(colonIdx + 1)) : 1433;
    const params = {};
    for (const part of parts) {
        const eqIdx = part.indexOf("=");
        if (eqIdx > 0) {
            params[part.slice(0, eqIdx).toLowerCase()] = part.slice(eqIdx + 1);
        }
    }
    return {
        server: server || "",
        port,
        database: params["database"] ?? params["initial catalog"] ?? "",
        user: params["user"] ?? params["user id"] ?? "",
        password: params["password"] ?? "",
        options: {
            encrypt: params["encrypt"] !== "false",
            trustServerCertificate: params["trustservercertificate"] === "true",
        },
    };
}
function createClient() {
    if (provider === "sqlserver") {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { PrismaMssql } = require("@prisma/adapter-mssql");
        const adapter = new PrismaMssql(parseMssqlUrl(url));
        return new client_1.PrismaClient({ adapter });
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaPg } = require("@prisma/adapter-pg");
    return new client_1.PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}
const prisma = createClient();
exports.default = prisma;
