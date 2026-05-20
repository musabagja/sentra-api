"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv = __importStar(require("dotenv"));
dotenv.config();
const sdk_node_1 = require("@opentelemetry/sdk-node");
const exporter_trace_otlp_http_1 = require("@opentelemetry/exporter-trace-otlp-http");
const exporter_logs_otlp_http_1 = require("@opentelemetry/exporter-logs-otlp-http");
const sdk_logs_1 = require("@opentelemetry/sdk-logs");
const auto_instrumentations_node_1 = require("@opentelemetry/auto-instrumentations-node");
const sdk = new sdk_node_1.NodeSDK({
    traceExporter: new exporter_trace_otlp_http_1.OTLPTraceExporter({
        url: process.env.SIGNOZ_ENDPOINT + '/v1/traces',
    }),
    logRecordProcessor: new sdk_logs_1.SimpleLogRecordProcessor(new exporter_logs_otlp_http_1.OTLPLogExporter({
        url: process.env.SIGNOZ_ENDPOINT + '/v1/logs',
    })),
    serviceName: process.env.OTEL_SERVICE_NAME || 'sentra-api',
    instrumentations: [
        (0, auto_instrumentations_node_1.getNodeAutoInstrumentations)({
            '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
    ],
});
sdk.start();
console.log('🔭 Tracer + Logger started');
process.on('SIGTERM', () => sdk.shutdown());
