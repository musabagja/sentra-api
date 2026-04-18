import express from "express";
import dotenv from "dotenv";
dotenv.config();
const app = express();
const port = process.env.PORT || 5000;
app.get("/", (req, res) => {
    return res.status(200).send({
        message: "Hello World!",
    });
});
app.listen(port, () => {
    console.log("Listening on " + port);
});
