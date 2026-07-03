import './tracer';

import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";

import router from "./src/routes";
import errorHandler from "./src/middlewares/error.handler";

const app = express();

const port = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === "production";
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const corsMode = process.env.CORS_MODE || (isProduction ? "strict" : "reflect");

app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true')
  next()
})
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors({
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    // Reflect/none modes allow any origin (convenient for shared dev/testing).
    if (corsMode === "reflect" || corsMode === "none") {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Reject without throwing: throwing yields a 500 with no CORS headers,
    // which surfaces as an opaque preflight failure in the browser.
    return callback(null, false);
  },
  credentials: true
}))
app.use(cookieParser(process.env.COOKIE_SECRET || 'default-secret'));
app.use("/api", router);
app.use(errorHandler);

app.listen(port, () => {
  console.log("Listening on " + port);
});