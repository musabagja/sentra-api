const errorHandler = (error, req, res, next) => {
    res.status(500).json({
        message: 'Internal server error',
        error: error.message
    });
};
export default errorHandler;
