import { DataSubjectError } from './errors';
import { compilePolicy } from './policy-compiler';

describe('compilePolicy', () => {
  it('keeps export allowlists independent of erasure policy and copies them', () => {
    const exportFields = ['id', 'email'];
    const policy = compilePolicy({
      entityName: 'User',
      subjectField: 'userId',
      fields: { email: 'delete', passwordHash: 'delete' },
      exportFields,
    });
    exportFields.push('passwordHash');
    expect(policy.exportFields).toEqual(['id', 'email']);
  });

  it('defaults missing export allowlists to no exported fields', () => {
    expect(compilePolicy({
      entityName: 'User',
      subjectField: 'userId',
      fields: { passwordHash: 'delete' },
    }).exportFields).toEqual([]);
  });

  it.each([[['']], [['   ']], [[' email']], [['email', 'email']], [[1]], ['email']])(
    'rejects malformed export allowlists %j', (exportFields) => {
      expect(() => compilePolicy({
        entityName: 'User',
        subjectField: 'userId',
        fields: { email: 'delete' },
        exportFields: exportFields as unknown as string[],
      })).toThrow(/exportFields/);
    },
  );

  it('normalizes shorthand "delete" to { strategy: "delete" }', () => {
    const policy = compilePolicy({
      entityName: 'User',
      subjectField: 'userId',
      fields: { email: 'delete' },
    });

    expect(policy.fields.email).toEqual({ strategy: 'delete' });
  });

  it('accepts anonymize with static replacement', () => {
    const policy = compilePolicy({
      entityName: 'User',
      subjectField: 'userId',
      fields: { email: { strategy: 'anonymize', replacement: '[REDACTED]' } },
    });

    expect(policy.fields.email).toEqual({
      strategy: 'anonymize',
      replacement: '[REDACTED]',
    });
  });

  it('rejects anonymize with function replacement', () => {
    expect(() =>
      compilePolicy({
        entityName: 'User',
        subjectField: 'userId',
        fields: {
          email: {
            strategy: 'anonymize',
            replacement: (() => 'x') as unknown as string,
          },
        },
      }),
    ).toThrow(DataSubjectError);
  });

  it('requires legalBasis for retain', () => {
    expect(() =>
      compilePolicy({
        entityName: 'Invoice',
        subjectField: 'customerId',
        fields: { amount: { strategy: 'retain' } as never },
      }),
    ).toThrow(/legalBasis/);
  });

  it('accepts retain with legalBasis', () => {
    const policy = compilePolicy({
      entityName: 'Invoice',
      subjectField: 'customerId',
      fields: {
        amount: {
          strategy: 'retain',
          legalBasis: 'tax:KR-basic-law-art85',
          until: '+7y',
        },
      },
    });

    expect(policy.fields.amount).toMatchObject({
      strategy: 'retain',
      legalBasis: 'tax:KR-basic-law-art85',
    });
  });

  it('defaults rowLevel to "delete-fields"', () => {
    const policy = compilePolicy({
      entityName: 'User',
      subjectField: 'userId',
      fields: { email: 'delete' },
    });

    expect(policy.rowLevel).toBe('delete-fields');
  });

  it('applies strict legalBasis when option set', () => {
    expect(() =>
      compilePolicy(
        {
          entityName: 'Invoice',
          subjectField: 'customerId',
          fields: { amount: { strategy: 'retain', legalBasis: 'bare-string' } },
        },
        { strictLegalBasis: true },
      ),
    ).toThrow(/scheme/);
  });
});
