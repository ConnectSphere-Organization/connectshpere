import { v2 as cloudinary } from 'cloudinary';
import { config } from '../config';

const name = config.cloudinary?.cloudName;
const key = config.cloudinary?.apiKey;
const secret = config.cloudinary?.apiSecret;

if (name && key && secret) {
  cloudinary.config({
    cloud_name: name,
    api_key: key,
    api_secret: secret,
  });
  console.log('[Cloudinary] Successfully configured connection credentials.');
} else {
  console.warn('[Cloudinary] Credentials missing. Media uploads are disabled.');
}

export class MediaStorageError extends Error {
  constructor(
    public readonly code: 'MEDIA_STORAGE_NOT_CONFIGURED' | 'MEDIA_STORAGE_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'MediaStorageError';
  }
}

/**
 * Upload a buffer to Cloudinary
 * @param fileBuffer The file buffer to upload
 * @param resourceType 'image', 'video', 'raw', or 'auto'
 * @param folder The folder path in Cloudinary
 * @returns Promise<any>
 */
export const uploadBufferToCloudinary = (
  fileBuffer: Buffer,
  resourceType: 'image' | 'video' | 'raw' | 'auto' = 'auto',
  folder = 'whatsapp_templates',
  options: {
    originalFilename?: string;
  } = {}
): Promise<any> => {
  return new Promise((resolve, reject) => {
    if (!name || !key || !secret) {
      return reject(new MediaStorageError(
        'MEDIA_STORAGE_NOT_CONFIGURED',
        'Media storage is not configured',
      ));
    }

    const rawFilename = (options.originalFilename || '');
    const filenameWithoutExt = rawFilename.replace(/\.[^/.]+$/, "");

    let safeFilename = filenameWithoutExt
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_+/g, '_');
    while (safeFilename.startsWith('_')) safeFilename = safeFilename.slice(1);
    while (safeFilename.endsWith('_')) safeFilename = safeFilename.slice(0, -1);

    const hasName = safeFilename.length > 0;
    const publicId = hasName
      ? `${Date.now()}-${safeFilename}`
      : `upload-${Date.now()}`;

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: resourceType,
        folder,
        public_id: publicId,
      },
      (error: any, result: any) => {
        if (error) {
          console.error('[Cloudinary] Upload stream error:', error);
          return reject(new MediaStorageError(
            'MEDIA_STORAGE_UNAVAILABLE',
            'Media storage is temporarily unavailable',
          ));
        }
        if (!result?.secure_url || !result?.public_id) {
          return reject(new MediaStorageError(
            'MEDIA_STORAGE_UNAVAILABLE',
            'Media storage returned an invalid response',
          ));
        }
        resolve(result);
      }
    );
    uploadStream.end(fileBuffer);
  });
};

export { cloudinary };
