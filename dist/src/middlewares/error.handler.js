"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const errorHandler = (error, req, res, next) => {
    const status = error.status || 500;
    res.status(status).json({
        message: error.message || 'Internal server error',
        // Present only on errors that carry a structured breakdown (e.g. bulk upload validation).
        ...(error.details !== undefined && { details: error.details })
    });
};
exports.default = errorHandler;
