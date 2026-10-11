import { AsyncLocalStorage } from 'node:async_hooks';
import {
  DataSubjectService,
  PrismaExecutionStore,
  type ArtifactStorage,
  type DeliveryContext,
  type PrismaDelegate,
  type Registry,
} from '@nestarc/data-subject';
import {
  TenancyContext,
  TenancyService,
  createPrismaTenancyExtension,
  tenancyTransaction,
} from '@nestarc/tenancy';
import { AuditContext, AuditService, type AuditActor } from '@nestarc/audit-log';
import { OutboxEmitter, OutboxEvent } from '@nestarc/outbox';
import { Prisma, PrismaClient } from './generated/client/client';

export interface VerifiedPrincipal {
  actorId: string;
  /** Set from the authenticated identity; omitted for existing user callers. */
  actorType?: AuditActor['type'];
  tenantIds: readonly string[];
}

class LifecycleEvent extends OutboxEvent {
  constructor(private readonly eventType: string, private readonly payload: Record<string, unknown>) {
    super();
  }

  getEventType(): string { return this.eventType; }
  toPayload(): Record<string, unknown> { return this.payload; }
}

/**
 * Copy beside your Prisma 7 generated client; adapt the model names to your schema.
 * This example uses manual lifecycle audit entries, not automatic row snapshots.
 */
export function createComposition(options: {
  prisma: PrismaClient;
  registry: (client: () => { profile: PrismaDelegate }) => Registry;
  artifactStorage: ArtifactStorage;
  schemaName: string;
  previewSigningKey: string;
}) {
  const tenantContext = new TenancyContext();
  const tenancy = new TenancyService(tenantContext);
  const transactions = new AsyncLocalStorage<Prisma.TransactionClient>();
  const scoped = options.prisma.$extends(createPrismaTenancyExtension(tenancy));
  // Root model reads receive their own RLS transaction. Interactive work uses
  // only tenancyTransaction's callback client, never the extended root client.
  const database = {
    dataSubjectRequest: scoped.dataSubjectRequest,
    dataSubjectExecution: scoped.dataSubjectExecution,
    $transaction: <T>(work: (tx: Prisma.TransactionClient) => Promise<T>, txOptions?: {
      isolationLevel?: 'Serializable'; maxWait?: number; timeout?: number;
    }) => tenancyTransaction(options.prisma, tenancy, work, txOptions),
  };
  const transaction = (): Prisma.TransactionClient => {
    const tx = transactions.getStore();
    if (!tx) throw new Error('A data-subject transaction is required');
    return tx;
  };
  const store = new PrismaExecutionStore({
    client: database,
    executionSchemaName: options.schemaName,
    bindTransaction: (tx, work) => transactions.run(tx, work),
  });
  const audit = new AuditService({
    prisma: options.prisma,
    prismaModule: { Prisma },
    actorExtractor: () => { throw new Error('Use the authenticated AuditContext boundary'); },
    actorRequired: true,
    tenantRequired: true,
    tenantResolver: () => tenancy.getCurrentTenantOrThrow(),
    tableName: `${options.schemaName}.audit_logs`,
  });
  const outbox = new OutboxEmitter({
    prisma: options.prisma,
    polling: { enabled: false },
    tenancy: { policy: 'require-match' },
  }, { getTenantId: () => tenancy.getCurrentTenantOrThrow() });
  const requireDelivery = (delivery?: DeliveryContext): DeliveryContext => {
    if (!delivery || delivery.tenantId !== tenancy.getCurrentTenantOrThrow())
      throw new Error('Durable delivery and tenant context must match');
    return delivery;
  };
  const deliverOnce = async (delivery: DeliveryContext, work: () => Promise<void>): Promise<void> => {
    const tx = transaction();
    // Outbox's idempotencyKey is metadata; this receipt owns deduplication.
    // A savepoint rolls back a sink that writes and then throws before returning.
    await tx.$executeRawUnsafe('SAVEPOINT data_subject_delivery');
    try {
      const inserted = await tx.$executeRaw`
        INSERT INTO "DataSubjectDeliveryReceipt" ("tenantId", "notificationId", "requestId")
        VALUES (${delivery.tenantId}, ${delivery.id}, ${delivery.requestId})
        ON CONFLICT ("tenantId", "notificationId") DO NOTHING`;
      if (inserted === 1) await work();
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT data_subject_delivery');
    } catch (error) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT data_subject_delivery');
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT data_subject_delivery');
      throw error;
    }
  };
  const service = new DataSubjectService({
    registry: options.registry(() => transactions.getStore() ?? scoped),
    requestStorage: store.requests,
    durableStore: store,
    artifactStorage: options.artifactStorage,
    previewSigningKey: options.previewSigningKey,
    slaDays: 30,
    publishOutbox: async (event, _payload, context) => {
      const delivery = requireDelivery(context);
      // Do not fan out subject identifiers or artifact locations by default.
      await deliverOnce(delivery, () => outbox.emit(transaction(), new LifecycleEvent(event, {
        requestId: delivery.requestId, notificationId: delivery.id,
      }), {
        tenantId: delivery.tenantId,
        idempotencyKey: delivery.id,
        correlationId: delivery.requestId,
        aggregateType: 'DataSubjectRequest',
        aggregateId: delivery.requestId,
      }));
    },
    publishAudit: async (event, _payload, context) => {
      const delivery = requireDelivery(context);
      await deliverOnce(delivery, () => audit.log({
        action: event,
        targetType: 'DataSubjectRequest',
        targetId: delivery.requestId,
        metadata: { notificationId: delivery.id },
      }, transaction()));
    },
  });

  return {
    service, tenancy, audit, outbox,
    /** Authenticate first; independently authorize the requested subject/action. */
    runForTenant<T>(principal: VerifiedPrincipal, tenantId: string, work: () => Promise<T>): Promise<T> {
      const actorType = principal.actorType ?? 'user';
      if (!principal.actorId.trim() || !tenantId.trim() || !principal.tenantIds.includes(tenantId) ||
          !['user', 'system', 'api_key'].includes(actorType))
        throw new Error('Tenant access denied');
      return tenantContext.run(tenantId, () => AuditContext.runAs({
        id: principal.actorId, type: actorType,
      }, work));
    },
  };
}
