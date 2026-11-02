import type { Request, Response, NextFunction } from 'express';
import {
  validateBucketName,
  createBucket,
  deleteBucket,
  checkBucket,
  minioDefaultBucket,
  resolveBucket,
  uploadFile,
  deleteFile,
  updateFile,
  bucketUsage,
  httpError
} from '../utils/minio.util';

class MinioController {
  /** POST /api/minio/files — upload file baru (multipart: file, opsional bucket & prefix) */
  static async uploadFile(req: Request, res: Response, next: NextFunction) {
    try {
      const file = req.file;
      if (!file || !file.buffer?.length) throw httpError(400, 'File wajib diunggah');
      const uploaded = await uploadFile(file, {
        bucket: resolveBucket(req.body?.bucket),
        ...(req.body?.prefix !== undefined ? { prefix: String(req.body.prefix) } : {})
      });
      res.status(201).json({ message: `File ${uploaded.fileName} diunggah`, data: { file: uploaded } });
    } catch (error) {
      next(error);
    }
  }

  /** PUT /api/minio/files — update file: unggah baru, lalu hapus yang lama (multipart) */
  static async updateFile(req: Request, res: Response, next: NextFunction) {
    try {
      const oldFileName = typeof req.body?.fileName === 'string' ? req.body.fileName.trim() : '';
      if (!oldFileName) throw httpError(400, 'fileName (file lama) wajib diisi');
      const file = req.file;
      if (!file || !file.buffer?.length) throw httpError(400, 'File wajib diunggah');
      const result = await updateFile(oldFileName, file, {
        bucket: resolveBucket(req.body?.bucket),
        ...(req.body?.prefix !== undefined ? { prefix: String(req.body.prefix) } : {})
      });
      res.status(200).json({
        message: `File ${oldFileName} diganti dengan ${result.fileName}`,
        data: { file: result }
      });
    } catch (error) {
      next(error);
    }
  }

}

export default MinioController;
