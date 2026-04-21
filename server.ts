import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import cors from "cors";

import router from "./src/routes";
import errorHandler from "./src/middlewares/error.handler";

dotenv.config();

const app = express();

const port = process.env.PORT || 5000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors({
  origin: "*"
}))
app.use(cookieParser(process.env.COOKIE_SECRET || 'default-secret'));
app.use("/api", router);
app.use(errorHandler);

app.listen(port, () => {
  console.log("Listening on " + port);
});