import * as dotenv from 'dotenv';
dotenv.config();

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: process.env.SIGNOZ_ENDPOINT + '/v1/traces',
  }),
  logRecordProcessor: new SimpleLogRecordProcessor(
    new OTLPLogExporter({
      url: process.env.SIGNOZ_ENDPOINT + '/v1/logs',
    })
  ),
  serviceName: process.env.OTEL_SERVICE_NAME || 'sentra-api',
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();
console.log('🔭 Tracer + Logger started');
process.on('SIGTERM', () => sdk.shutdown());