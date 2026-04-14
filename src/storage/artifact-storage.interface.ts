export interface ArtifactStorage {
  put(key: string, body: Buffer, contentType: string): Promise<string>;
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>;
}
