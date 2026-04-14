import type { ArtifactStorage } from './artifact-storage.interface';

export class InMemoryArtifactStorage implements ArtifactStorage {
  private readonly store = new Map<
    string,
    { body: Buffer; contentType: string }
  >();

  async put(key: string, body: Buffer, contentType: string): Promise<string> {
    this.store.set(key, { body, contentType });
    return `memory://${key}`;
  }

  async get(
    key: string,
  ): Promise<{ body: Buffer; contentType: string } | null> {
    return this.store.get(key) ?? null;
  }
}
