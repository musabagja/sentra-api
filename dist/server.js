"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("./tracer");
const express_1 = __importDefault(require("express"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const cors_1 = __importDefault(require("cors"));
const routes_1 = __importDefault(require("./src/routes"));
const error_handler_1 = __importDefault(require("./src/middlewares/error.handler"));
const app = (0, express_1.default)();
const port = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === "production";
const allowedOrigins = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
const corsMode = process.env.CORS_MODE || (isProduction ? "strict" : "reflect");
app.use((req, res, next) => {
    res.setHeader('ngrok-skip-browser-warning', 'true');
    next();
});
app.use(express_1.default.urlencoded({ extended: true }));
app.use(express_1.default.json());
app.use((0, cors_1.default)({
    origin(origin, callback) {
        if (!origin) {
            return callback(null, true);
        }
        // Reflect mode is convenient for shared dev/testing.
        if (corsMode === "reflect") {
            return callback(null, true);
        }
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error("Not allowed by CORS"));
    },
    credentials: true
}));
app.use((0, cookie_parser_1.default)(process.env.COOKIE_SECRET || 'default-secret'));
app.use("/api", routes_1.default);
app.use(error_handler_1.default);
app.listen(port, () => {
    console.log("Listening on " + port);
});
