import type { ArtifactStorage } from '../../src/storage/artifact-storage.interface';

export function artifactStorageContract(
  name: string,
  factory: () => ArtifactStorage,
): void {
  describe(`ArtifactStorage contract: ${name}`, () => {
    let storage: ArtifactStorage;

    beforeEach(() => {
      storage = factory();
    });

    it('put returns a URL-like string', async () => {
      const url = await storage.put('k1', Buffer.from('hi'), 'text/plain');

      expect(typeof url).toBe('string');
      expect(url.length).toBeGreaterThan(0);
    });

    it('put + get round-trips content', async () => {
      await storage.put('k1', Buffer.from('hello'), 'application/zip');

      const result = await storage.get('k1');
      expect(result?.body.toString()).toBe('hello');
      expect(result?.contentType).toBe('application/zip');
    });

    it('get returns null for missing key', async () => {
      expect(await storage.get('missing')).toBeNull();
    });
  });
}
