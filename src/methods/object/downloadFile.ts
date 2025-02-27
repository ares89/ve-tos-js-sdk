import TOSBase, { TosResponse } from '../base';
import {
  DEFAULT_PART_SIZE,
  isCancelError,
  makeSerialAsyncTask,
  safeParseCheckpointFile,
} from '../../utils';
import * as fsp from '../../nodejs/fs-promises';
import { DataTransferStatus, DataTransferType } from '../../interface';
import headObject, { HeadObjectInput, HeadObjectOutput } from './headObject';
import { CancelToken } from 'axios';
import { Stats } from 'fs';
import path from 'path';
import TosClientError from '../../TosClientError';
import { getObjectV2, GetObjectV2Output } from './getObject';
import TosServerError from '../../TosServerError';
import { CancelError } from '../../CancelError';
import { IRateLimiter } from '../../universal/rate-limiter';
import { validateCheckpoint } from './utils';
import { createCrcReadStream } from '../../nodejs/CrcReadStream';
import { CRC } from '../../universal/crc';
import { combineCrc64 } from '../../universal/crc';

export interface DownloadFileCheckpointRecord {
  bucket: string;
  key: string;
  version_id?: string;
  part_size: number;

  object_info: {
    etag: string;
    hash_crc64ecma: string;
    object_size: number;
    last_modified: string;
  };

  file_info: {
    file_path: string;
    temp_file_path: string;
  };

  parts_info: DownloadFileCheckpointRecordPartInfo[];
}

export interface DownloadFileCheckpointRecordPartInfo {
  part_number: number;
  range_start: number;
  range_end: number;
  hash_crc64ecma: string;
  is_completed: boolean;
}

export interface DownloadFileInput extends HeadObjectInput {
  filePath: string;
  /**
   * @private unstable tempFilePath
   */
  tempFilePath?: string;

  /**
   * default is 20 MB
   *
   * unit: B
   */
  partSize?: number;

  /**
   * the number of request to parallel upload part，default value is 1
   */
  taskNum?: number;

  /**
   * if checkpoint is a string and point to a exist file,
   * the checkpoint record will recover from this file.
   *
   * if checkpoint is a string and point to a directory,
   * the checkpoint will be auto generated,
   * and its name is `{bucketName}_{objectName}.{uploadId}`.
   */
  checkpoint?: string | DownloadFileCheckpointRecord;

  dataTransferStatusChange?: (status: DataTransferStatus) => void;

  /**
   * the simple progress feature
   * percent is [0, 1]
   */
  progress?: (
    percent: number,
    checkpoint: DownloadFileCheckpointRecord
  ) => void;

  /**
   * the feature of pause and continue downloading
   */
  downloadEventChange?: (event: DownloadEvent) => void;

  /**
   * cancel this upload progress
   */
  cancelToken?: CancelToken;
  /**
   * unit: bit/s
   * server side traffic limit
   **/
  trafficLimit?: number;
  /**
   * only works for nodejs environment
   */
  rateLimiter?: IRateLimiter;

  /**
   * @private unstable
   * custom rename file to support not overwrite file
   */
  customRenameFileAfterDownloadCompleted?: (
    tempFilePath: string,
    filePath: string
  ) => void;
}
export interface DownloadFileOutput extends HeadObjectOutput {}

export interface DownloadEvent {
  type: DownloadEventType;
  err?: Error;

  bucket: string;
  key: string;
  versionId?: string;
  filePath: string;
  checkpointFile?: string;
  downloadPartInfo?: DownloadPartInfo;
}

export interface DownloadPartInfo {
  partNumber: number;
  rangeStart: number;
  rangeEnd: number;
}

export enum DownloadEventType {
  CreateTempFileSucceed = 1,
  CreateTempFileFailed,
  DownloadPartSucceed,
  DownloadPartFailed,
  DownloadPartAborted,
  RenameTempFileSucceed,
  RenameTempFileFailed,
}

interface CheckpointRichInfo {
  filePath?: string | undefined;

  filePathIsPlaceholder?: boolean;

  record?: DownloadFileCheckpointRecord;
}

interface Task {
  partSize: number;
  offset: number;
  partNumber: number;
}

const CHECKPOINT_FILE_NAME_PLACEHOLDER = '@@checkpoint-file-placeholder@@';
const ABORT_ERROR_STATUS_CODE = [403, 404, 405];

export async function downloadFile(
  this: TOSBase,
  input: DownloadFileInput
): Promise<TosResponse<DownloadFileOutput>> {
  if (process.env.TARGET_ENVIRONMENT === 'browser') {
    throw new TosClientError(
      '`downloadFile` is not supported in browser environment'
    );
  }
  const { cancelToken, versionId } = input;
  const isCancel = () => cancelToken && !!cancelToken.reason;
  validateCheckpoint(input.checkpoint);

  const headObjectRes = await headObject.call(this, {
    bucket: input.bucket,
    key: input.key,
    versionId,
  });
  const { data: objectStats } = headObjectRes;
  const etag = objectStats['etag'];
  const symlinkTargetSize = objectStats['x-tos-symlink-target-size'] ?? 0;
  const objectSize =
    objectStats['x-tos-object-type'] === 'Symlink'
      ? +symlinkTargetSize
      : +objectStats['content-length'];

  const checkpointRichInfo = await (async (): Promise<CheckpointRichInfo> => {
    if (process.env.TARGET_ENVIRONMENT === 'node') {
      if (typeof input.checkpoint === 'string') {
        const { checkpoint } = input;
        // file doesn't exist when stat is null
        let checkpointStat: Stats | null = null;
        try {
          checkpointStat = await fsp.stat(checkpoint);
        } catch (_err) {
          // TODO: remove any
          const err = _err as any;
          if (err.code === 'ENOENT') {
            // file doesn't exist
          } else {
            throw err;
          }
        }

        const isDirectory = (() => {
          if (checkpointStat) {
            return checkpointStat.isDirectory();
          }
          return checkpoint.endsWith('/');
        })();

        // filePath will generated by uploadId, use placeholder temporarily
        const filePath = isDirectory
          ? path.resolve(checkpoint, CHECKPOINT_FILE_NAME_PLACEHOLDER)
          : checkpoint;
        const dirPath = path.dirname(filePath);
        // ensure directory exist
        await fsp.safeMkdirRecursive(dirPath);

        if (isDirectory) {
          return {
            filePath,
            filePathIsPlaceholder: true,
          };
        }

        return {
          filePath,
          filePathIsPlaceholder: false,
          // filePath is json file
          // TODO: validate json schema
          record: checkpointStat
            ? await safeParseCheckpointFile(filePath)
            : undefined,
        };
      }
    }

    if (typeof input.checkpoint === 'object') {
      return {
        record: input.checkpoint,
      };
    }

    return {};
  })();

  // check if file info is matched
  await (async () => {
    if (checkpointRichInfo.record?.object_info) {
      const { last_modified, object_size } =
        checkpointRichInfo.record?.object_info;
      if (
        // TODO: `last-modified` aligns to number
        objectStats['last-modified'] !== last_modified ||
        objectSize !== object_size
      ) {
        console.warn(
          `The file has been modified since ${new Date(
            last_modified
          )}, so the checkpoint file is invalid, and specified object will be downloaded again.`
        );
        delete checkpointRichInfo.record;
      }
    }
  })();

  const partSize =
    input.partSize || checkpointRichInfo.record?.part_size || DEFAULT_PART_SIZE;

  // check partSize is matched
  if (
    checkpointRichInfo.record &&
    checkpointRichInfo.record.part_size !== partSize
  ) {
    console.warn(
      'The partSize param does not equal the partSize in checkpoint file, ' +
        'so the checkpoint file is invalid, and specified object will be downloaded again.'
    );
    delete checkpointRichInfo.record;
  }

  let bucket = input.bucket || this.opts.bucket || '';
  const key = input.key;
  const filePath = await (async () => {
    let filePathStats: Stats | null = null;
    try {
      filePathStats = await fsp.stat(input.filePath);
    } catch (_err) {
      const err = _err as any;
      if (err.code === 'ENOENT') {
        // file doesn't exist
      } else {
        throw err;
      }
    }

    const isDirectory = (() => {
      if (filePathStats) {
        return filePathStats.isDirectory();
      }
      return input.filePath.endsWith('/');
    })();
    const filePath = isDirectory
      ? path.resolve(input.filePath, key)
      : input.filePath;

    const dirPath = path.dirname(filePath);
    await fsp.safeMkdirRecursive(dirPath);

    return filePath;
  })();
  const [tempFilePath, isExist] = await (async () => {
    const tempFilePath = input.tempFilePath
      ? input.tempFilePath
      : filePath + '.temp';
    let isExist = true;
    try {
      await fsp.stat(tempFilePath);
    } catch (_err) {
      const err = _err as any;
      if (err.code === 'ENOENT') {
        isExist = false;
        // file doesn't exist
      } else {
        throw err;
      }
    }
    return [tempFilePath, isExist];
  })();
  if (checkpointRichInfo.record) {
    if (!isExist) {
      console.warn(
        "The temp file doesn't not exist " +
          'so the checkpoint file is invalid, and specified object will be downloaded again.'
      );
      delete checkpointRichInfo.record;
    }
  }

  let tasks: Task[] = [];
  const allTasks: Task[] = getAllTasks(objectSize, partSize);
  const initConsumedBytes = (checkpointRichInfo.record?.parts_info || [])
    .filter((it) => it.is_completed)
    .reduce((prev, it) => prev + (it.range_end - it.range_start + 1), 0);

  // recorded tasks
  const recordedTasks = checkpointRichInfo.record?.parts_info || [];
  const recordedTaskMap: Map<number, DownloadFileCheckpointRecordPartInfo> =
    new Map();
  recordedTasks.forEach((it) => recordedTaskMap.set(it.part_number, it));

  const nextEnsureCloseFd = async () => {
    const getCheckpointContent = () => {
      const checkpointContent: DownloadFileCheckpointRecord = {
        bucket,
        key,
        version_id: versionId,
        part_size: partSize,
        parts_info: recordedTasks,
        file_info: {
          file_path: filePath,
          temp_file_path: tempFilePath,
        },
        object_info: {
          last_modified: objectStats['last-modified'],
          etag: etag,
          hash_crc64ecma: objectStats['x-tos-hash-crc64ecma'] || '',
          object_size: objectSize,
        },
      };
      return checkpointContent;
    };
    const triggerDownloadEvent = (
      e: Omit<
        DownloadEvent,
        'bucket' | 'versionId' | 'key' | 'checkpointFile' | 'filePath'
      >
    ) => {
      if (!input.downloadEventChange) {
        return;
      }

      const event: DownloadEvent = {
        bucket,
        versionId,
        key,
        filePath,
        ...e,
      };
      if (checkpointRichInfo.filePath) {
        event.checkpointFile = checkpointRichInfo.filePath;
      }

      input.downloadEventChange(event);
    };

    let consumedBytesForProgress = initConsumedBytes;
    enum TriggerProgressEventType {
      start = 0,
      downloadPartSucceed = 1,
      renameTempFileSucceed = 2,
    }
    const triggerProgressEvent = (type: TriggerProgressEventType) => {
      if (!input.progress) {
        return;
      }

      const percent = (() => {
        if (type === TriggerProgressEventType.start && objectSize === 0) {
          return 0;
        }
        return !objectSize ? 1 : consumedBytesForProgress / objectSize;
      })();

      if (
        consumedBytesForProgress === objectSize &&
        type === TriggerProgressEventType.downloadPartSucceed
      ) {
        // 100% 仅在 complete 后处理，以便 100% 可以拉取到新对象
      } else {
        input.progress(percent, getCheckpointContent());
      }
    };
    let consumedBytes = initConsumedBytes;
    const { dataTransferStatusChange } = input;
    const triggerDataTransfer = (
      type: DataTransferType,
      rwOnceBytes: number = 0
    ) => {
      if (!dataTransferStatusChange) {
        return;
      }
      consumedBytes += rwOnceBytes;

      dataTransferStatusChange?.({
        type,
        rwOnceBytes,
        consumedBytes,
        totalBytes: objectSize,
      });
    };
    const writeCheckpointFile = makeSerialAsyncTask(async () => {
      if (
        process.env.TARGET_ENVIRONMENT === 'node' &&
        checkpointRichInfo.filePath
      ) {
        const content = JSON.stringify(getCheckpointContent(), null, 2);
        const dirPath = path.dirname(checkpointRichInfo.filePath); // ensure directory exist

        await fsp.safeMkdirRecursive(dirPath);
        await fsp.writeFile(checkpointRichInfo.filePath, content, 'utf-8');
      }
    });
    const rmCheckpointFile = async () => {
      if (
        process.env.TARGET_ENVIRONMENT === 'node' &&
        checkpointRichInfo.filePath
      ) {
        await fsp.rm(checkpointRichInfo.filePath).catch((err: any) => {
          // eat err
          console.warn(
            'remove checkpoint file failure, you can remove it by hand.\n',
            `checkpoint file path: ${checkpointRichInfo.filePath}\n`,
            err.message
          );
        });
      }
    };

    /**
     *
     * @param task one part task
     * @param downloadPartRes upload part failed if `downloadPartRes` is Error
     */
    const updateAfterDownloadPart = async (
      task: Task,
      downloadPartRes:
        | {
            res: GetObjectV2Output & { rangeHashCrc64ecma: string };
            err?: null;
          }
        | {
            err: Error;
          }
    ) => {
      let existRecordTask = recordedTaskMap.get(task.partNumber);
      const rangeStart = task.offset;
      const rangeEnd = Math.min(task.offset + partSize - 1, objectSize - 1);
      if (!existRecordTask) {
        existRecordTask = {
          part_number: task.partNumber,
          range_start: rangeStart,
          range_end: rangeEnd,
          hash_crc64ecma: '',
          is_completed: false,
        };
        recordedTasks.push(existRecordTask);
        recordedTaskMap.set(existRecordTask.part_number, existRecordTask);
      }

      if (!downloadPartRes.err) {
        existRecordTask.is_completed = true;
        existRecordTask.hash_crc64ecma = downloadPartRes.res.rangeHashCrc64ecma;
      }

      await writeCheckpointFile();
      const downloadPartInfo: DownloadPartInfo = {
        partNumber: existRecordTask.part_number,
        rangeStart,
        rangeEnd,
      };

      if (downloadPartRes.err) {
        const err = downloadPartRes.err;
        let type: DownloadEventType = DownloadEventType.DownloadPartFailed;

        if (err instanceof TosServerError) {
          if (ABORT_ERROR_STATUS_CODE.includes(err.statusCode)) {
            type = DownloadEventType.DownloadPartAborted;
          }
        }

        triggerDownloadEvent({
          type,
          err,
          downloadPartInfo: downloadPartInfo,
        });
        return;
      }

      consumedBytesForProgress +=
        downloadPartInfo.rangeEnd - downloadPartInfo.rangeStart + 1;

      triggerDownloadEvent({
        type: DownloadEventType.DownloadPartSucceed,
        downloadPartInfo: downloadPartInfo,
      });
      triggerProgressEvent(TriggerProgressEventType.downloadPartSucceed);
    };

    if (checkpointRichInfo.record) {
      bucket = checkpointRichInfo.record.bucket;

      // checkpoint info exists, so need to calculate remain tasks
      const uploadedPartSet: Set<number> = new Set(
        (checkpointRichInfo.record.parts_info || [])
          .filter((it) => it.is_completed)
          .map((it) => it.part_number)
      );
      tasks = allTasks.filter((it) => !uploadedPartSet.has(it.partNumber));
    } else {
      try {
        // create temp file
        await fsp.writeFile(tempFilePath, '', {
          flag: 'w+',
        });
      } catch (_err) {
        const err = _err as any;
        triggerDownloadEvent({
          type: DownloadEventType.CreateTempFileFailed,
          err,
        });
        throw err;
      }

      if (checkpointRichInfo.filePathIsPlaceholder) {
        checkpointRichInfo.filePath = checkpointRichInfo.filePath?.replace(
          `${CHECKPOINT_FILE_NAME_PLACEHOLDER}`,
          getDefaultCheckpointFilePath(bucket, key, versionId)
        );
      }

      triggerDownloadEvent({
        type: DownloadEventType.CreateTempFileSucceed,
      });
      triggerDataTransfer(DataTransferType.Started);
      tasks = allTasks;
    }

    const handleTasks = async () => {
      let firstErr: Error | null = null;
      let index = 0;

      // TODO: how to test parallel does work, measure time is not right
      await Promise.all(
        Array.from({ length: input.taskNum || 1 }).map(async () => {
          while (true) {
            const currentIndex = index++;
            if (currentIndex >= tasks.length) {
              return;
            }

            const curTask = tasks[currentIndex];
            let consumedBytesThisTask = 0;
            try {
              const res = await getObjectV2.call(this, {
                bucket,
                key,
                versionId,
                headers: {
                  'if-match': etag,
                  range: `bytes=${curTask.offset}-${Math.min(
                    curTask.offset + curTask.partSize - 1,
                    objectSize - 1
                  )}`,
                },
                trafficLimit: input.trafficLimit,
                rateLimiter: input.rateLimiter,
                dataTransferStatusChange(status) {
                  if (status.type !== DataTransferType.Rw) {
                    return;
                  }
                  if (isCancel()) {
                    return;
                  }
                  consumedBytesThisTask += status.rwOnceBytes;
                  triggerDataTransfer(DataTransferType.Rw, status.rwOnceBytes);
                },
              });

              // need to handle stream's error event before throw a error
              // if (isCancel()) {
              //   throw new CancelError('cancel downloadFile');
              // }

              let dataStream = res.data.content;
              const crcInst = new CRC();
              if (
                process.env.TARGET_ENVIRONMENT === 'node' &&
                this.opts.enableCRC
              ) {
                dataStream = createCrcReadStream(dataStream, crcInst);
              }
              await new Promise((resolve, reject) => {
                const writeStream = fsp.createWriteStream(tempFilePath, {
                  start: curTask.offset,
                  flags: 'r+',
                });

                let isErr = false;
                let err: any = null;
                writeStream.on('close', () => {
                  if (isErr) {
                    reject(err);
                  } else {
                    resolve(undefined);
                  }
                });

                writeStream.on('error', (_err) => {
                  isErr = true;
                  err = _err;
                });

                dataStream.pipe(writeStream);
                dataStream.on('error', (err) => writeStream.destroy(err));
                function handleOnceCancel() {
                  if (isCancel()) {
                    reject(new CancelError('cancel downloadFile'));
                    // fix windows
                    writeStream.end();
                    dataStream.unpipe(writeStream);
                    dataStream.off('data', handleOnceCancel);
                  }
                }
                dataStream.on('data', handleOnceCancel);
              });

              if (isCancel()) {
                throw new CancelError('cancel downloadFile');
              }

              await updateAfterDownloadPart(curTask, {
                res: { ...res.data, rangeHashCrc64ecma: crcInst.getCrc64() },
              });
            } catch (_err) {
              const err = _err as any;
              consumedBytes -= consumedBytesThisTask;
              consumedBytesThisTask = 0;

              if (isCancelError(err)) {
                throw err;
              }

              if (isCancel()) {
                throw new CancelError('cancel downloadFile');
              }

              if (!firstErr) {
                firstErr = err;
              }
              await updateAfterDownloadPart(curTask, { err });
            }
          }
        })
      );

      if (firstErr) {
        throw firstErr;
      }

      const serverCRC64 = headObjectRes.data['x-tos-hash-crc64ecma'];
      if (this.opts.enableCRC && serverCRC64) {
        const actualCrc64 = combineCRCInParts(getCheckpointContent());
        if (actualCrc64 !== serverCRC64) {
          throw new TosClientError(
            `validate file crc64 failed. Expect crc64 ${serverCRC64}, actual crc64 ${actualCrc64}. Please try again.`
          );
        }
      }
    };

    const handleEmptyObj = async () => {};

    triggerProgressEvent(TriggerProgressEventType.start);
    objectSize === 0 ? await handleEmptyObj() : await handleTasks();

    try {
      if (typeof input.customRenameFileAfterDownloadCompleted === 'function') {
        await input.customRenameFileAfterDownloadCompleted(
          tempFilePath,
          filePath
        );
      } else {
        await fsp.rename(tempFilePath, filePath);
      }
    } catch (_err) {
      const err = _err as any;
      triggerDownloadEvent({
        type: DownloadEventType.RenameTempFileFailed,
        err,
      });
      triggerDataTransfer(DataTransferType.Failed);
      throw err;
    }

    triggerDownloadEvent({
      type: DownloadEventType.RenameTempFileSucceed,
    });
    triggerProgressEvent(TriggerProgressEventType.renameTempFileSucceed);
    triggerDataTransfer(DataTransferType.Succeed);
    await rmCheckpointFile();

    return headObjectRes;
  };

  try {
    return await nextEnsureCloseFd();
  } finally {
    // there is no global fd, don't need to close fd
  }
}

export default downloadFile;

/**
 * 即使 totalSize 是 0，也需要一个 Part，否则 Server 端会报错 read request body failed
 */
function getAllTasks(totalSize: number, partSize: number) {
  const tasks: Task[] = [];
  for (let i = 0; ; ++i) {
    const offset = i * partSize;
    const currPartSize = Math.min(partSize, totalSize - offset);

    tasks.push({
      offset,
      partSize: currPartSize,
      partNumber: i + 1,
    });

    if ((i + 1) * partSize >= totalSize) {
      break;
    }
  }

  return tasks;
}

function getDefaultCheckpointFilePath(
  bucket: string,
  key: string,
  versionId?: string
) {
  const originPath = `${bucket}_${key}.${versionId}.json`;
  const normalizePath = originPath.replace(/[\\/]/g, '');
  return normalizePath;
}

function combineCRCInParts(cp: DownloadFileCheckpointRecord) {
  let res = '0';
  const sortedPartsInfo =
    cp.parts_info?.sort?.((a, b) => a.part_number - b.part_number) ?? [];
  for (const part of sortedPartsInfo) {
    res = combineCrc64(
      res,
      part.hash_crc64ecma,
      part.range_end - part.range_start + 1
    );
  }
  return res;
}
