"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateImageURLs = void 0;
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
// Configure storage
const storage = multer_1.default.memoryStorage();
// File filter to accept only xlsx files
const xlsxFilter = (req, file, cb) => {
    const allowedMimes = [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/octet-stream'
    ];
    const extname = path_1.default.extname(file.originalname).toLowerCase() === '.xlsx';
    if (allowedMimes.includes(file.mimetype) || extname) {
        cb(null, true);
    }
    else {
        cb(new Error('Only .xlsx files are allowed'), false);
    }
};
const imageFilter = (req, file, cb) => {
    const allowedMimes = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp'
    ];
    const extname = path_1.default.extname(file.originalname).toLowerCase();
    if (allowedMimes.includes(file.mimetype) || ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(extname)) {
        cb(null, true);
    }
    else {
        cb(new Error('Only image files are allowed'), false);
    }
};
const fileSwitcher = (type) => {
    switch (type) {
        case 'xlsx':
            return xlsxFilter;
        case 'image':
            return imageFilter;
        default:
            return xlsxFilter;
    }
};
// Initialize multer
const upload = (type) => (0, multer_1.default)({
    storage,
    fileFilter: fileSwitcher(type),
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
    },
});
// Middleware to generate URLs for uploaded images and attach to req.body
const generateImageURLs = (req, res, next) => {
    const files = req.files;
    if (files) {
        Object.keys(files).forEach(fieldname => {
            const fileArray = files[fieldname];
            if (fileArray && fileArray.length > 0) {
                const file = fileArray[0];
                if (file) {
                    const url = `/uploads/${file.originalname}`;
                    // Strip "File" suffix and replace with "URL"
                    // imageFile -> imageURL, signFile -> signURL, avatarFile -> avatarURL
                    const urlKey = fieldname.endsWith("File")
                        ? `${fieldname.slice(0, -4)}URL`
                        : `${fieldname}URL`;
                    req.body[urlKey] = url;
                }
            }
        });
    }
    next();
};
exports.generateImageURLs = generateImageURLs;
exports.default = upload;
