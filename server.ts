import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import cors from "cors";

import router from "./src/routes";
import errorHandler from "./src/middlewares/error.handler";

dotenv.config();

const app = express();

const port = process.env.PORT || 5000;
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// app.use(cors({
//   origin(origin, callback) {
//     if (!origin) {
//       return callback(null, true);
//     }

//     if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
//       return callback(null, true);
//     }

//     return callback(new Error("Not allowed by CORS"));
//   },
//   credentials: true
// }))
app.use(cors({
  origin: "*",
  credentials: true
}))
app.use(cookieParser(process.env.COOKIE_SECRET || 'default-secret'));
app.use("/api", router);
app.use(errorHandler);

app.listen(port, () => {
  console.log("Listening on " + port);
});