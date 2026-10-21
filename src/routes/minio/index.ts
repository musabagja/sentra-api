import express from 'express';
import Auth from '../../middlewares/auth.handler';
import upload from '../../utils/multer.config';
import MinioController from '../../controllers/minio.controller';

const router = express.Router();

// ============================================================================
// MINIO STORAGE ROUTES (bucket management + file upload/delete/update/stats)
// ============================================================================

// Semua route wajib login: user harus terautentikasi (access_token + session valid)
router.use(Auth.authenticate);

// GET /api/minio/buckets/check?name= - Cek koneksi + eksistensi bucket (default: MINIO_BUCKET)
router.get('/buckets/check', MinioController.checkBucket);

// POST /api/minio/buckets - Buat bucket baru (body: { "name": "prodis-bucket" })
router.post('/buckets', MinioController.createBucket);

// DELETE /api/minio/buckets - Hapus bucket kosong (body: { "name": "prodis-bucket" })
router.delete('/buckets', MinioController.deleteBucket);

// POST /api/minio/files - Upload file baru (multipart: file, opsional bucket & prefix)
router.post('/files', upload('any').single('file'), MinioController.uploadFile);

// GET /api/minio/files/stats?bucket= - Total file & pemakaian storage pada bucket
router.get('/files/stats', MinioController.fileStats);

// PUT /api/minio/files - Update file: unggah baru lalu hapus yang lama (multipart: file + fileName)
router.put('/files', upload('any').single('file'), MinioController.updateFile);

// DELETE /api/minio/files - Hapus file yang ada (body: { "fileName", "bucket"? })
router.delete('/files', MinioController.deleteFile);

export default router;
