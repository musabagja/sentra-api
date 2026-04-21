const errorHandler = (error, req, res, next) => {
    console.log(error);
    res.status(500).json({
        message: 'Internal server error',
        error: error.message
    });
};
export default errorHandler;
