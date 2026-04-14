import { InMemoryArtifactStorage } from '../../src/storage/in-memory-artifact-storage';
import { artifactStorageContract } from '../contract/artifact-storage-contract';

artifactStorageContract('InMemoryArtifactStorage', () => new InMemoryArtifactStorage());
