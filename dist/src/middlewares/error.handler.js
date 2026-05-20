"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const errorHandler = (error, req, res, next) => {
    const status = error.status || 500;
    res.status(status).json({
        message: error.message || 'Internal server error',
    });
};
exports.default = errorHandler;
