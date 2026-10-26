import express from 'express';
import Auth from '../../middlewares/auth.handler';
import upload from '../../utils/multer.config';
import MinioController from '../../controllers/minio.controller';

const router = express.Router();

router.use(Auth.authenticate);

// POST /api/minio/files - Upload file baru (multipart: file, opsional bucket & prefix)
router.post('/files', upload('any').single('file'), MinioController.uploadFile);

// PUT /api/minio/files - Update file: unggah baru lalu hapus yang lama (multipart: file + fileName)
router.put('/files', upload('any').single('file'), MinioController.updateFile);

export default router;
