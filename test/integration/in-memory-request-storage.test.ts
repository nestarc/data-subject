import { InMemoryRequestStorage } from '../../src/storage/in-memory-request-storage';
import { requestStorageContract } from '../contract/request-storage-contract';

requestStorageContract('InMemoryRequestStorage', () => new InMemoryRequestStorage());
