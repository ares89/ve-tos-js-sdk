import TosClientError from '../../../TosClientError';
import { fillRequestHeaders } from '../../../utils';
import TOSBase from '../../base';

export interface CompleteMultipartUploadInput {
  bucket?: string;
  key: string;
  uploadId: string;
  parts: {
    eTag: string;
    partNumber: number;
  }[];
  /**
   * when true `parts` param need to be empty array
   */
  completeAll?: boolean;

  callback?: string;
  callbackVar?: string;
  forbidOverwrite?: boolean;

  headers?: {
    ['x-tos-forbid-overwrite']?: string;
  };
}

export type UploadedPart = {
  PartNumber: number;
  ETag: string;
};

export interface CompleteMultipartUploadOutput {
  Bucket: string;
  Key: string;
  ETag: string;
  Location: string;
  VersionID?: string;
  HashCrc64ecma?: string;
  /** the field has a value when completeAll is true
   * when specify callback, the field will not has a value
   */
  CompletedParts?: UploadedPart[];
  CallbackResult?: string;
}

export async function completeMultipartUpload(
  this: TOSBase,
  input: CompleteMultipartUploadInput
) {
  input.headers = input.headers ?? {};
  fillRequestHeaders(input, ['callback', 'callbackVar', 'forbidOverwrite']);

  const handleResponse = (response: {
    headers: { [x: string]: any };
    data: CompleteMultipartUploadOutput;
  }) => {
    const bucket = input.bucket || this.opts.bucket || '';
    const headers = response.headers;
    const result: CompleteMultipartUploadOutput = {
      ...{
        VersionID: headers['x-tos-version-id'],
        ETag: headers['etag'],
        Bucket: bucket,
        Location: headers['location'],
        HashCrc64ecma: headers['x-tos-hash-crc64ecma'],
        Key: input.key,
      },
      ...response.data,
    };
    if (input.callback) {
      result.CallbackResult = `${JSON.stringify(response.data)}`;
    }
    return result;
  };
  if (input.completeAll) {
    if (input.parts?.length > 0) {
      throw new TosClientError(
        `Should not specify both 'completeAll' and 'parts' params.`
      );
    }
    return this._fetchObject<CompleteMultipartUploadOutput>(
      input,
      'POST',
      {
        uploadId: input.uploadId,
      },
      {
        ...input.headers,
        'x-tos-complete-all': 'yes',
      },
      undefined,
      {
        handleResponse,
      }
    );
  }

  return this._fetchObject<CompleteMultipartUploadOutput>(
    input,
    'POST',
    {
      uploadId: input.uploadId,
    },
    {
      ...input.headers,
    },
    {
      Parts: input.parts.map((it) => ({
        ETag: it.eTag,
        PartNumber: it.partNumber,
      })),
    },
    {
      handleResponse,
    }
  );
}
