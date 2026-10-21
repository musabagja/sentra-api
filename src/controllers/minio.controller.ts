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

/**
 * MinIO bucket management. Payload is just the bucket name
 * (e.g. { "name": "prodis-bucket" }); the credential in .env may create buckets.
 */
class MinioController {
  /** POST /api/minio/buckets — buat bucket baru (idempoten) */
  static async createBucket(req: Request, res: Response, next: NextFunction) {
    try {
      const name = validateBucketName(req.body?.name);
      const result = await createBucket(name);
      res.status(result.created ? 201 : 200).json({
        message: result.created ? `Bucket ${name} dibuat` : `Bucket ${name} sudah ada`,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  /** DELETE /api/minio/buckets — hapus bucket (hanya yang kosong) */
  static async deleteBucket(req: Request, res: Response, next: NextFunction) {
    try {
      const name = validateBucketName(req.body?.name);
      const result = await deleteBucket(name);
      res.status(200).json({ message: `Bucket ${name} dihapus`, data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/minio/buckets/check?name=... — diagnostic: is the MinIO server reachable and
   * does the bucket exist? Without `name` the configured bucket (MINIO_BUCKET) is checked.
   * Always answers with the facts: `reachable: false` + `error` when the server cannot be
   * reached (DNS/network), `exists: false` when it can but the bucket is not there.
   */
  static async checkBucket(req: Request, res: Response, next: NextFunction) {
    try {
      const raw = req.query.name ?? req.body?.name;
      const name = raw !== undefined && raw !== '' ? validateBucketName(raw) : minioDefaultBucket();
      const result = await checkBucket(name);
      res.status(200).json({
        message: !result.reachable
          ? `Tidak dapat terhubung ke server MinIO (${result.endpoint})`
          : result.exists
            ? `Bucket ${name} dapat diakses`
            : `Bucket ${name} tidak ditemukan di server MinIO`,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  // ------------------------------------------------------------------ files

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

  /** DELETE /api/minio/files — hapus file yang ada (body: { fileName, bucket? }) */
  static async deleteFile(req: Request, res: Response, next: NextFunction) {
    try {
      const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName.trim() : '';
      if (!fileName) throw httpError(400, 'fileName wajib diisi');
      const result = await deleteFile(fileName, { bucket: resolveBucket(req.body?.bucket) });
      res.status(200).json({ message: `File ${fileName} dihapus`, data: result });
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

  /** GET /api/minio/files/stats?bucket= — total file & pemakaian storage pada bucket */
  static async fileStats(req: Request, res: Response, next: NextFunction) {
    try {
      const usage = await bucketUsage({ bucket: resolveBucket(req.query.bucket) });
      res.status(200).json({
        message: `Statistik bucket ${usage.bucket} berhasil diambil`,
        data: usage
      });
    } catch (error) {
      next(error);
    }
  }
}

export default MinioController;
