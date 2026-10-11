/**
 * Pass the real @aws-sdk/client-s3 module and s3-request-presigner.getSignedUrl.
 * Kept dependency-injected so this example adds no core runtime dependencies.
 */
function createAwsS3Transport({ client, sdk, getSignedUrl }) {
  const send = (Command, input) => client.send(new Command(input));
  return {
    async inspectBucket(Bucket) {
      const [access, ownership, versioning] = await Promise.all([
        send(sdk.GetPublicAccessBlockCommand, { Bucket }),
        send(sdk.GetBucketOwnershipControlsCommand, { Bucket }),
        send(sdk.GetBucketVersioningCommand, { Bucket }),
      ]);
      const block = access.PublicAccessBlockConfiguration || {};
      return {
        publicAccessBlocked: ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets']
          .every((key) => block[key] === true),
        aclDisabled: ownership.OwnershipControls?.Rules?.some((rule) => rule.ObjectOwnership === 'BucketOwnerEnforced') === true,
        versioning: versioning.Status === undefined ? 'disabled'
          : versioning.Status === 'Enabled' ? 'enabled' : 'suspended',
      };
    },
    async put(input) { await send(sdk.PutObjectCommand, input); },
    async head(input) {
      try { return await send(sdk.HeadObjectCommand, input); }
      catch (error) {
        if (error?.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async get(input) {
      const result = await send(sdk.GetObjectCommand, input);
      if (!result.Body?.transformToByteArray) throw new Error('S3 body is unavailable');
      return { ...result, body: Buffer.from(await result.Body.transformToByteArray()) };
    },
    async list(input) {
      const result = await send(sdk.ListObjectsV2Command, input);
      if (result.IsTruncated && !result.NextContinuationToken) throw new Error('S3 pagination token is unavailable');
      return {
        keys: (result.Contents || []).map((object) => object.Key).filter((key) => typeof key === 'string'),
        nextToken: result.IsTruncated ? result.NextContinuationToken : undefined,
      };
    },
    async delete(input) { await send(sdk.DeleteObjectCommand, input); },
    signGet(input, expiresIn) {
      return getSignedUrl(client, new sdk.GetObjectCommand(input), { expiresIn });
    },
  };
}

module.exports = { createAwsS3Transport };
