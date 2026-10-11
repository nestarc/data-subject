import { DataSubjectError, DataSubjectErrorCode } from '../errors';
import type { DataSubjectRequest } from '../types';

const IMMUTABLE_FIELDS = new Set([
  'id',
  'tenantId',
  'subjectId',
  'type',
  'createdAt',
]);

export function validateRequestIdentifier(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DataSubjectError(
      DataSubjectErrorCode.InvalidInput,
      `${field} must be a non-empty string`,
    );
  }
}

export function validateRequestIdentity(request: DataSubjectRequest): void {
  validateRequestIdentifier(request.id, 'id');
  validateRequestIdentifier(request.tenantId, 'tenantId');
  validateRequestIdentifier(request.subjectId, 'subjectId');
}

export function validateRequestPatch(patch: Partial<DataSubjectRequest>): void {
  for (const [field, value] of Object.entries(patch)) {
    if (IMMUTABLE_FIELDS.has(field) && value !== undefined) {
      throw new DataSubjectError(
        DataSubjectErrorCode.InvalidInput,
        `request identity field ${field} cannot be updated`,
      );
    }
  }
}
