import type { Request, Response, NextFunction } from 'express';
import { FILE_URL_EXPIRY_SECONDS, ensureStoredFile, presignedFileUrl } from '../utils/minio.util';
import { ProdisError, prodisOk, validationFailed } from '../utils/prodis.util';

class ProdisFileController {
  static async getUrl(req: Request, res: Response, next: NextFunction) {
    try {
      const raw = req.query.fileName;
      if (typeof raw !== 'string' || !raw.trim()) {
        throw validationFailed([{ field: 'fileName', code: 'REQUIRED', message: 'fileName is required' }]);
      }
      const fileName = raw.trim();

      try {
        await ensureStoredFile(fileName);
      } catch (error: any) {
        if (error?.status === 404) throw new ProdisError(404, 'NOT_FOUND', 'File not found');
        throw new ProdisError(503, 'SERVICE_UNAVAILABLE', 'Storage is temporarily unavailable');
      }

      const url = await presignedFileUrl(fileName);
      if (!url) throw new ProdisError(503, 'SERVICE_UNAVAILABLE', 'Failed to generate file URL');

      prodisOk(
        res,
        { fileName, url, expiresIn: FILE_URL_EXPIRY_SECONDS },
        { message: 'File URL generated successfully' }
      );
    } catch (error) {
      next(error);
    }
  }
}

export default ProdisFileController;
