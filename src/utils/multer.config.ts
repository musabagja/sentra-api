import multer from 'multer';
import path from 'path';
import type { Request } from 'express';

// Configure storage
const storage = multer.memoryStorage();

// File filter to accept only xlsx files
const xlsxFilter = (req: any, file: any, cb: any) => {
  const allowedMimes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream'
  ];
  
  const extname = path.extname(file.originalname).toLowerCase() === '.xlsx';
  
  if (allowedMimes.includes(file.mimetype) || extname) {
    cb(null, true);
  } else {
    cb(new Error('Only .xlsx files are allowed'), false);
  }
};

const imageFilter = (req: any, file: any, cb: any) => {
  const allowedMimes = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp'
  ];
  
  const extname = path.extname(file.originalname).toLowerCase();
  
  if (allowedMimes.includes(file.mimetype) || ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(extname)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed'), false);
  }
};

const fileSwitcher = (type: 'xlsx' | 'image') => {
  switch (type) {
    case 'xlsx':
      return xlsxFilter;
    case 'image':
      return imageFilter;
    default:
      return xlsxFilter;
  }
}

// Initialize multer
const upload = (type: 'xlsx' | 'image') => multer({
  storage,
  fileFilter: fileSwitcher(type),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
});

// Middleware to generate URLs for uploaded images and attach to req.body
export const generateImageURLs = (req: Request, res: any, next: any) => {
  const files = req.files as { [fieldname: string]: Express.Multer.File[] };
  
  if (files) {
    Object.keys(files).forEach(fieldname => {
      const fileArray = files[fieldname];
      if (fileArray && fileArray.length > 0) {
        const file = fileArray[0];
        if (file) {
          // Generate URL for the uploaded file
          // TODO: Replace with actual cloud storage upload (AWS S3, Cloudinary, etc.)
          const url = `/uploads/${file.originalname}`;
          // Attach URL to req.body as fieldnameURL
          (req.body as any)[`${fieldname}URL`] = url;
        }
      }
    });
  }
  
  next();
};

export default upload;
