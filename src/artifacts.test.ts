import { erasureEvidenceArtifactKey, exportArtifactKey } from './artifacts';

describe('artifact namespaces', () => {
  it.each(['.', '..', '/', '../other', 't%2Fother', '한글'])(
    'encodes tenant/request %j as single non-traversing segments',
    (id) => {
      const key = exportArtifactKey(id, id);
      expect(key.split('/')).toHaveLength(4);
      expect(key.split('/')).not.toContain('..');
      expect(key.split('/')).not.toContain('.');
      expect(erasureEvidenceArtifactKey(id, id)).not.toBe(key);
    },
  );
});
