"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Telemetry must start before the app is imported so auto-instrumentation can
// patch express/http. Tests import ./app directly and skip this entirely.
require("./tracer");
const app_1 = __importDefault(require("./app"));
const port = process.env.PORT || 5000;
app_1.default.listen(port, () => {
    console.log("Listening on " + port);
});
