import { Client } from 'minio';
import { randomUUID } from 'crypto';

/**
 * MinIO/S3 storage helpers (adapted from references/minio-nextjs-reference/minio.service.ts,
 * NestJS -> Express). Connection comes from the MINIO_* variables (.env.example):
 * MINIO_ENDPOINT, MINIO_PORT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_BUCKET.
 */

export const minioDefaultBucket = (): string => process.env.MINIO_BUCKET || 'prodis-bucket';

export const minioEndpoint = (): string => process.env.MINIO_ENDPOINT || 's3.ap-southeast-3.amazonaws.com';

export const httpError = (status: number, message: string) => {
  const err = new Error(message);
  (err as any).status = status;
  return err;
};

// Connectivity / credential failures come back as raw driver errors
// (e.g. "getaddrinfo ENOTFOUND ..."); they become one clear message instead.
const CONNECTIVITY_CODES = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'];

const mapStorageError = (error: any): never => {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? error);
  if (CONNECTIVITY_CODES.includes(code) || /getaddrinfo|network/i.test(message)) {
    throw httpError(503, `Tidak dapat terhubung ke server MinIO (${minioEndpoint()}): ${code || message}`);
  }
  if (/AccessDenied|SignatureDoesNotMatch|InvalidAccessKeyId/i.test(code + message)) {
    throw httpError(502, 'Akses ke server MinIO ditolak (periksa MINIO_ACCESS_KEY / MINIO_SECRET_KEY)');
  }
  if (code === 'NoSuchBucket') {
    throw httpError(404, 'Bucket tidak ditemukan di server MinIO');
  }
  throw error;
};

// S3/MinIO bucket naming: 3-63 chars, lowercase letters, digits, dots and hyphens
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export const validateBucketName = (value: unknown): string => {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const valid =
    BUCKET_NAME_PATTERN.test(name) &&
    !name.includes('..') &&
    !name.startsWith('xn--') &&
    !name.endsWith('-s3alias') &&
    !name.endsWith('--ol-s3');
  if (!valid) {
    throw httpError(400, 'Nama bucket tidak valid (3-63 karakter: huruf kecil, angka, titik, atau hyphen)');
  }
  return name;
};

let client: Client | null = null;

export const getMinioClient = (): Client => {
  if (!client) {
    const accessKey = process.env.MINIO_ACCESS_KEY;
    const secretKey = process.env.MINIO_SECRET_KEY;
    if (!accessKey || !secretKey) {
      throw httpError(500, 'Konfigurasi MinIO belum lengkap (MINIO_ACCESS_KEY / MINIO_SECRET_KEY)');
    }
    client = new Client({
      endPoint: process.env.MINIO_ENDPOINT || 's3.ap-southeast-3.amazonaws.com',
      port: Number(process.env.MINIO_PORT) || 443,
      useSSL: true,
      accessKey,
      secretKey
    });
  }
  return client;
};

/** Creates a bucket. Idempotent: an existing bucket is reported with `created: false`. */
export const createBucket = async (name: string): Promise<{ name: string; created: boolean }> => {
  const minio = getMinioClient();
  let already: boolean;
  try {
    already = await minio.bucketExists(name);
  } catch (error) {
    return mapStorageError(error);
  }
  if (already) return { name, created: false };
  try {
    await minio.makeBucket(name);
  } catch (error: any) {
    // Someone created it between the check and the call: still a success
    if (error?.code === 'BucketAlreadyOwnedByYou' || error?.code === 'BucketAlreadyExists') {
      return { name, created: false };
    }
    return mapStorageError(error);
  }
  return { name, created: true };
};

/** Removes an empty bucket. A missing bucket is a 404; a non-empty one a 409 (never deletes files). */
export const deleteBucket = async (name: string): Promise<{ name: string; deleted: true }> => {
  const minio = getMinioClient();
  let exists: boolean;
  try {
    exists = await minio.bucketExists(name);
  } catch (error) {
    return mapStorageError(error);
  }
  if (!exists) throw httpError(404, 'Bucket tidak ditemukan');
  try {
    await minio.removeBucket(name);
  } catch (error: any) {
    if (error?.code === 'NoSuchBucket') throw httpError(404, 'Bucket tidak ditemukan');
    if (error?.code === 'BucketNotEmpty' || /not empty/i.test(String(error?.message ?? ''))) {
      throw httpError(409, 'Bucket tidak kosong. Kosongkan dulu isinya sebelum menghapus.');
    }
    return mapStorageError(error);
  }
  return { name, deleted: true };
};

/**
 * Diagnostic check ("apakah bucket ini bekerja?"): reports whether the MinIO server is
 * reachable and whether the bucket exists there. Never throws on connectivity problems —
 * it reports them (`reachable: false` + `error`) so callers can tell DNS/network issues
 * apart from a missing bucket.
 */
export const checkBucket = async (
  name: string
): Promise<{ name: string; exists: boolean; reachable: boolean; endpoint: string; error?: string }> => {
  const minio = getMinioClient();
  const endpoint = minioEndpoint();
  try {
    const exists = await minio.bucketExists(name);
    return { name, exists, reachable: true, endpoint };
  } catch (error: any) {
    return {
      name,
      exists: false,
      reachable: false,
      endpoint,
      error: String(error?.code ?? error?.message ?? error)
    };
  }
};

// ---------------------------------------------------------------------- files

export interface UploadedFile {
  fileName: string;
  bucket: string;
  size: number;
  url: string;
}

// Presigned GET links are valid for 7 days; clients re-request the file URL when expired
const FILE_URL_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

/** The bucket a file call works on: the one in the payload, or MINIO_BUCKET from .env */
export const resolveBucket = (value?: unknown): string =>
  value !== undefined && value !== '' ? validateBucketName(value) : minioDefaultBucket();

const isMissingKey = (error: any): boolean => {
  const code = String(error?.code ?? '');
  return code === 'NotFound' || code === 'NoSuchKey' || /specified key does not exist|not found/i.test(String(error?.message ?? ''));
};

const requireFileStat = async (bucket: string, fileName: string) => {
  try {
    return await getMinioClient().statObject(bucket, fileName);
  } catch (error: any) {
    if (isMissingKey(error)) throw httpError(404, 'File tidak ditemukan');
    return mapStorageError(error);
  }
};

const fileUrl = async (bucket: string, fileName: string): Promise<string> => {
  try {
    return await getMinioClient().presignedGetObject(bucket, fileName, FILE_URL_EXPIRY_SECONDS);
  } catch {
    return '';
  }
};

/** Uploads one new file. The object name is generated (uuid + timestamp + original name,
 *  same shape as the reference service) so stored names stay unguessable. */
export const uploadFile = async (
  file: Express.Multer.File,
  options: { bucket?: string; prefix?: string } = {}
): Promise<UploadedFile> => {
  const bucket = resolveBucket(options.bucket);
  const prefix = (options.prefix ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  const fileName = `${randomUUID()}-${prefix ? `${prefix}-` : ''}${Date.now()}-${file.originalname}`;
  try {
    await getMinioClient().putObject(bucket, fileName, file.buffer, file.size, {
      'Content-Type': file.mimetype
    });
  } catch (error) {
    return mapStorageError(error);
  }
  return { fileName, bucket, size: file.size, url: await fileUrl(bucket, fileName) };
};

/** Deletes one existing file (404 when it is not there). */
export const deleteFile = async (
  fileName: string,
  options: { bucket?: string } = {}
): Promise<{ fileName: string; bucket: string; deleted: true }> => {
  const bucket = resolveBucket(options.bucket);
  await requireFileStat(bucket, fileName);
  try {
    await getMinioClient().removeObject(bucket, fileName);
  } catch (error) {
    return mapStorageError(error);
  }
  return { fileName, bucket, deleted: true };
};

/**
 * Updates a file: the new content is uploaded first and the old object removed after, so a
 * failure can never leave the caller with neither file. The returned `fileName` is the NEW
 * object name (callers replace their stored reference); `replacedFileName` is what was removed.
 */
export const updateFile = async (
  oldFileName: string,
  file: Express.Multer.File,
  options: { bucket?: string; prefix?: string } = {}
): Promise<UploadedFile & { replacedFileName: string; previousDeleted: boolean }> => {
  const bucket = resolveBucket(options.bucket);
  await requireFileStat(bucket, oldFileName);

  const uploaded = await uploadFile(file, {
    bucket,
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {})
  });

  let previousDeleted = true;
  try {
    await getMinioClient().removeObject(bucket, oldFileName);
  } catch {
    // The new file is safely in place; an orphaned old object only shows up in the usage stats
    previousDeleted = false;
  }
  return { ...uploaded, replacedFileName: oldFileName, previousDeleted };
};

/** Total file count and storage usage of one bucket (sum of all object sizes). */
export const bucketUsage = (
  options: { bucket?: string } = {}
): Promise<{ bucket: string; endpoint: string; totalFiles: number; totalSize: number; totalSizeFormatted: string }> => {
  const bucket = resolveBucket(options.bucket);
  return new Promise((resolve, reject) => {
    let totalFiles = 0;
    let totalSize = 0;
    const stream = getMinioClient().listObjects(bucket, '', true);
    stream.on('data', (item: { name?: string; size?: number }) => {
      if (item?.name && typeof item.size === 'number') {
        totalFiles += 1;
        totalSize += item.size;
      }
    });
    stream.on('end', () =>
      resolve({
        bucket,
        endpoint: minioEndpoint(),
        totalFiles,
        totalSize,
        totalSizeFormatted: formatBytes(totalSize)
      })
    );
    stream.on('error', (error) => {
      try {
        mapStorageError(error);
      } catch (mapped) {
        reject(mapped);
      }
    });
  });
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 'B';
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(1)} ${unit}`;
};
