/** The narrow S3 contract used by the example; no SDK is a package dependency. */
export interface S3ObjectInput { Bucket: string; Key: string }
export interface S3ObjectMetadata {
  Metadata?: Record<string, string>;
  ContentType?: string;
  ETag?: string;
  ContentLength?: number;
}
export interface S3Transport {
  inspectBucket(bucket: string): Promise<{
    publicAccessBlocked: boolean;
    aclDisabled: boolean;
    versioning: 'disabled' | 'enabled' | 'suspended';
  }>;
  put(input: S3ObjectInput & {
    Body: Buffer;
    ContentType: string;
    Metadata: Record<string, string>;
    IfNoneMatch: '*';
    ChecksumSHA256: string;
    ServerSideEncryption: 'AES256';
  }): Promise<void>;
  head(input: S3ObjectInput): Promise<S3ObjectMetadata | null>;
  get(input: S3ObjectInput & { IfMatch: string }): Promise<S3ObjectMetadata & { body: Buffer }>;
  list(input: { Bucket: string; Prefix: string; ContinuationToken?: string }): Promise<{
    keys: string[];
    nextToken?: string;
  }>;
  delete(input: S3ObjectInput & { IfMatch: string }): Promise<void>;
  signGet(input: S3ObjectInput, expiresIn: number): Promise<string>;
}
