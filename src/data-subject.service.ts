import { createHash, randomUUID } from 'node:crypto';

import { EraseRunner } from './erase-runner';
import { DataSubjectError, DataSubjectErrorCode } from './errors';
import { ExportRunner } from './export-runner';
import type { Registry } from './registry';
import type { ArtifactStorage } from './storage/artifact-storage.interface';
import type { RequestStorage } from './storage/request-storage.interface';
import type {
  DataSubjectRequest,
  RequestState,
  RequestType,
} from './types';

export interface DataSubjectServiceDeps {
  registry: Registry;
  requestStorage: RequestStorage;
  artifactStorage: ArtifactStorage;
  slaDays: number;
  idFactory?: () => string;
  clock?: () => Date;
  publishOutbox?: (type: string, payload: unknown) => Promise<void>;
  publishAudit?: (event: string, data: Record<string, unknown>) => Promise<void>;
  runInTransaction?: <T>(work: () => Promise<T>) => Promise<T>;
}

export class DataSubjectService {
  private readonly idFactory: () => string;
  private readonly clock: () => Date;
  private readonly publishOutbox: NonNullable<
    DataSubjectServiceDeps['publishOutbox']
  >;
  private readonly publishAudit: NonNullable<
    DataSubjectServiceDeps['publishAudit']
  >;
  private readonly runInTransaction: NonNullable<
    DataSubjectServiceDeps['runInTransaction']
  >;

  constructor(private readonly deps: DataSubjectServiceDeps) {
    this.idFactory = deps.idFactory ?? (() => randomUUID());
    this.clock = deps.clock ?? (() => new Date());
    this.publishOutbox = deps.publishOutbox ?? (async () => {});
    this.publishAudit = deps.publishAudit ?? (async () => {});
    this.runInTransaction = deps.runInTransaction ?? (async (work) => work());
  }

  async export(
    subjectId: string,
    tenantId: string,
  ): Promise<DataSubjectRequest> {
    const request = await this.createRequest('export', subjectId, tenantId);

    try {
      await this.setState(request.id, 'processing');

      const runner = new ExportRunner(
        this.deps.registry,
        this.deps.artifactStorage,
      );
      const result = await runner.run(request.id, subjectId, tenantId);

      await this.deps.requestStorage.update(request.id, {
        state: 'completed',
        completedAt: this.clock(),
        artifactHash: result.artifactHash,
        artifactUrl: result.artifactUrl,
        stats: result.stats,
      });

      await this.publishOutbox('data_subject.request_completed', {
        requestId: request.id,
        state: 'completed',
        artifactHash: result.artifactHash,
      });
    } catch (error) {
      await this.markFailed(request.id, error);
      await this.publishOutbox('data_subject.request_failed', {
        requestId: request.id,
        failureReason: messageFromError(error),
      });
    }

    return this.mustLoad(request.id);
  }

  async erase(
    subjectId: string,
    tenantId: string,
  ): Promise<DataSubjectRequest> {
    const request = await this.createRequest('erase', subjectId, tenantId);

    try {
      await this.runInTransaction(async () => {
        await this.publishOutbox('data_subject.erasure_requested', {
          requestId: request.id,
          subjectId,
          tenantId,
          requestedAt: this.clock().toISOString(),
        });

        await this.setState(request.id, 'processing');

        const runner = new EraseRunner(this.deps.registry);
        const result = await runner.run(subjectId, tenantId);
        const report = JSON.stringify({ requestId: request.id, stats: result.stats });
        const artifactHash = createHash('sha256').update(report).digest('hex');

        await this.deps.requestStorage.update(request.id, {
          state: 'completed',
          completedAt: this.clock(),
          stats: result.stats,
          artifactHash,
        });

        await this.publishOutbox('data_subject.request_completed', {
          requestId: request.id,
          state: 'completed',
          artifactHash,
        });
      });
    } catch (error) {
      await this.markFailed(request.id, error);
      await this.publishOutbox('data_subject.request_failed', {
        requestId: request.id,
        failureReason: messageFromError(error),
      });
    }

    return this.mustLoad(request.id);
  }

  async getRequest(id: string): Promise<DataSubjectRequest> {
    return this.mustLoad(id);
  }

  async listByTenant(
    tenantId: string,
    opts: { state?: RequestState } = {},
  ): Promise<DataSubjectRequest[]> {
    return this.deps.requestStorage.listByTenant(tenantId, opts);
  }

  async listOverdue(): Promise<DataSubjectRequest[]> {
    return this.deps.requestStorage.listOverdue(this.clock());
  }

  private async createRequest(
    type: RequestType,
    subjectId: string,
    tenantId: string,
  ): Promise<DataSubjectRequest> {
    const now = this.clock();
    const dueAt = new Date(now.getTime() + this.deps.slaDays * 86_400_000);
    const request: DataSubjectRequest = {
      id: this.idFactory(),
      tenantId,
      subjectId,
      type,
      state: 'created',
      createdAt: now,
      dueAt,
      completedAt: null,
      failedAt: null,
      failureReason: null,
      artifactHash: null,
      artifactUrl: null,
      stats: null,
      requestedBy: null,
    };

    await this.deps.requestStorage.insert(request);
    await this.publishOutbox('data_subject.request_created', {
      requestId: request.id,
      type,
      subjectId,
      tenantId,
    });
    await this.publishAudit('data_subject.request_created', {
      requestId: request.id,
      type,
      tenantId,
    });

    return request;
  }

  private async setState(id: string, state: RequestState): Promise<void> {
    await this.deps.requestStorage.update(id, { state });
  }

  private async markFailed(id: string, error: unknown): Promise<void> {
    await this.deps.requestStorage.update(id, {
      state: 'failed',
      failedAt: this.clock(),
      failureReason: messageFromError(error),
    });
  }

  private async mustLoad(id: string): Promise<DataSubjectRequest> {
    const request = await this.deps.requestStorage.findById(id);
    if (!request) {
      throw new DataSubjectError(
        DataSubjectErrorCode.RequestNotFound,
        `request ${id} not found`,
      );
    }

    return request;
  }
}

function messageFromError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
