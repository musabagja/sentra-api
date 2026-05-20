// src/middleware/otelBody.ts
import { trace } from '@opentelemetry/api';

export function otelBodyHandler(req: any, res: any, next: any) {
  const span = trace.getActiveSpan();
  if (!span) return next();

  // request body — remove sensitive fields
  if (req.body) {
    const safeBody = { ...req.body };
    delete safeBody.password;
    delete safeBody.token;
    delete safeBody.refreshToken;
    span.setAttribute('http.request.body', JSON.stringify(safeBody));
  }

  // response body
  const originalJson = res.json.bind(res);
  res.json = (body: any) => {
    const safeResponse = { ...body };
    delete safeResponse.token;
    delete safeResponse.refreshToken;
    span.setAttribute('http.response.body', JSON.stringify(safeResponse));
    return originalJson(body);
  };

  next();
}