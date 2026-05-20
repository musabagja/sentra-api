"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.otelBodyHandler = otelBodyHandler;
// src/middleware/otelBody.ts
const api_1 = require("@opentelemetry/api");
function otelBodyHandler(req, res, next) {
    const span = api_1.trace.getActiveSpan();
    if (!span)
        return next();
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
    res.json = (body) => {
        const safeResponse = { ...body };
        delete safeResponse.token;
        delete safeResponse.refreshToken;
        span.setAttribute('http.response.body', JSON.stringify(safeResponse));
        return originalJson(body);
    };
    next();
}
