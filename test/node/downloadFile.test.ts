import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import TOS, {
  CancelToken,
  DataTransferType,
  DownloadEventType,
  isCancel,
} from '../../src/browser-index';
import { NEVER_TIMEOUT, sleepCache } from '../utils';
import { tosOptions } from '../utils/options';
import * as utils from './utils';
import { DownloadEvent } from '../../src/methods/object/downloadFile';
import { safeAwait } from '../../src/utils';

const {
  checkpointsDir,
  downloadFileDir,
  objectPath100M,
  objectPath10M,
  objectPath1K,
  objectPathEmpty,
} = utils;

const objectKeyEmpty = utils.objectKeyEmpty + ' - downloadFile';
const objectKey1K = utils.objectKey1K + ' - downloadFile';
const objectKey10M = utils.objectKey10M + ' - downloadFile';
const objectKey100M = utils.objectKey100M + ' - downloadFile';

describe('downloadFile', () => {
  beforeAll(async (done) => {
    const client = new TOS(tosOptions);

    await Promise.all([
      client.uploadFile({ file: objectPathEmpty, key: objectKeyEmpty }),
      client.uploadFile({ file: objectPath1K, key: objectKey1K }),
      client.uploadFile({
        file: objectPath10M,
        key: objectKey10M,
        taskNum: 10,
      }),
      client.uploadFile({
        file: objectPath100M,
        key: objectKey100M,
        taskNum: 10,
      }),
    ]);
    done();
  }, NEVER_TIMEOUT);

  it(
    'download empty file',
    async () => {
      const client = new TOS(tosOptions);
      await client.downloadFile({
        filePath: downloadFileDir,
        key: objectKeyEmpty,
      });
      const { size } = await fsp.stat(
        path.resolve(downloadFileDir, objectKeyEmpty)
      );
      expect(size).toEqual(0);
    },
    NEVER_TIMEOUT
  );

  it(
    'download 100M file',
    async () => {
      const client = new TOS(tosOptions);
      await client.downloadFile({
        filePath: downloadFileDir,
        key: objectKey100M,
        taskNum: 5,
      });
      const { size } = await fsp.stat(
        path.resolve(downloadFileDir, objectKey100M)
      );
      expect(size).toEqual(100 * 1024 * 1024);
    },
    NEVER_TIMEOUT
  );

  it(
    'download 100M file-pause-resume-right-progress',
    async () => {
      const client = new TOS(tosOptions);
      const checkpointPath = path.resolve(
        checkpointsDir,
        `download 100M file - pause - resume.checkpoint.json`
      );
      const filePath = path.resolve(
        downloadFileDir,
        'download 100M file - pause - resume.txt'
      );
      while (true) {
        const progressFn = jest.fn();
        const cancelTokenSource = CancelToken.source();

        // sleep 3 ~ 6
        const sleepTime = (Math.random() * 3 + 3) * 1000;
        setTimeout(() => {
          cancelTokenSource.cancel();
        }, sleepTime);
        const [err, res] = await safeAwait(
          client.downloadFile({
            filePath,
            key: objectKey100M,
            checkpoint: checkpointPath,
            taskNum: 1,
            progress: progressFn,
            cancelToken: cancelTokenSource.token,
            partSize: 5_000_001,
          })
        );

        const progressFnCallsLen = progressFn.mock.calls.length;
        // console.log('progressFnCallsLen: ', progressFnCallsLen);
        for (let i = 0; i < progressFnCallsLen; ++i) {
          const oneCall = progressFn.mock.calls[i];
          if (oneCall[0] <= 1) {
            // console.log('process: ', oneCall[0]);
            if (oneCall[0] === 1) {
              expect(i).toBe(progressFnCallsLen - 1);
            }
          } else {
            expect(oneCall[0]).toBeLessThanOrEqual(1);
          }

          await sleepCache(sleepTime);
          // 确保 progress 不会接受新的调用
          expect(progressFn.mock.calls.length).toBe(progressFnCallsLen);
        }

        if (err) {
          expect(err.toString().includes('cancel')).toBe(true);
        } else {
          const { size } = await fsp.stat(filePath);
          expect(size).toEqual(100 * 1024 * 1024);
          return;
        }
      }
    },
    NEVER_TIMEOUT
  );

  it(
    'downloadFile 10M dataTransfer and progress-partSize=1M',
    async () => {
      const client = new TOS(tosOptions);
      const progressFn = jest.fn();
      const dataTransferFn = jest.fn();
      const filePath = path.resolve(
        downloadFileDir,
        '10M-dataTransfer and progress-partSize=1M'
      );
      await client.downloadFile({
        key: objectKey10M,
        filePath,
        taskNum: 10,
        dataTransferStatusChange: dataTransferFn,
        progress: progressFn,
        partSize: 1 * 1024 * 1024,
      });

      const progressFnCallsLen = progressFn.mock.calls.length;
      expect(progressFn.mock.calls[0][0]).toEqual(0);
      expect(progressFn.mock.calls.filter((it) => it[0] === 1).length).toEqual(
        1
      );
      const lastCall = progressFn.mock.calls.slice(-1)[0];
      expect(lastCall[0]).toEqual(1);
      for (let i = 1; i < progressFnCallsLen; ++i) {
        expect(progressFn.mock.calls[i][0].toFixed(6)).toBe(
          (0.1 * i).toFixed(6)
        );
      }

      const totalBytes = 10 * 1024 * 1024;
      expect(
        dataTransferFn.mock.calls[0][0].type === DataTransferType.Started
      ).toBe(true);
      expect(dataTransferFn.mock.calls[0][0].totalBytes === totalBytes).toBe(
        true
      );
      const dataTransferCallLen = dataTransferFn.mock.calls.length;
      for (let i = 2; i < dataTransferCallLen; ++i) {
        expect(
          dataTransferFn.mock.calls[i][0].consumedBytes ===
            dataTransferFn.mock.calls[i][0].rwOnceBytes +
              dataTransferFn.mock.calls[i - 1][0].consumedBytes
        ).toBe(true);
      }

      const lastData = dataTransferFn.mock.calls[dataTransferCallLen - 2][0];
      expect(
        lastData.type === DataTransferType.Rw &&
          lastData.consumedBytes === lastData.totalBytes
      ).toBe(true);
      expect(
        dataTransferFn.mock.calls[dataTransferCallLen - 1][0].type ===
          DataTransferType.Succeed
      ).toBe(true);
    },
    NEVER_TIMEOUT
  );

  it(
    'downloadFile 10M dataTransfer and progress-partSize=7177B',
    async () => {
      const client = new TOS(tosOptions);
      const progressFn = jest.fn();
      const dataTransferFn = jest.fn();
      const filePath = path.resolve(
        downloadFileDir,
        '10M-dataTransfer and progress-partSize=7177B'
      );
      await client.downloadFile({
        key: objectKey10M,
        filePath,
        taskNum: 10,
        dataTransferStatusChange: dataTransferFn,
        progress: progressFn,
        partSize: 7177,
      });
      const totalBytes = 10 * 1024 * 1024;

      const progressFnCallsLen = progressFn.mock.calls.length;
      expect(progressFn.mock.calls[0][0]).toEqual(0);
      expect(progressFn.mock.calls.filter((it) => it[0] === 1).length).toEqual(
        1
      );
      const lastCall = progressFn.mock.calls.slice(-1)[0];
      expect(lastCall[0]).toEqual(1);
      for (let i = 1; i < progressFnCallsLen; ++i) {
        const curPercent = progressFn.mock.calls[i][0].toFixed(6);
        const expectPercent1 = ((7177 * i) / totalBytes).toFixed(6);
        const expectPercent2 = (
          (7177 * (i - 1) + (totalBytes % 7177)) /
          totalBytes
        ).toFixed(6);
        const isOk =
          curPercent === expectPercent1 || curPercent === expectPercent2;
        expect(isOk).toBeTruthy();
      }

      expect(
        dataTransferFn.mock.calls[0][0].type === DataTransferType.Started
      ).toBe(true);
      expect(dataTransferFn.mock.calls[0][0].totalBytes === totalBytes).toBe(
        true
      );
      const dataTransferCallLen = dataTransferFn.mock.calls.length;
      for (let i = 2; i < dataTransferCallLen; ++i) {
        expect(
          dataTransferFn.mock.calls[i][0].consumedBytes ===
            dataTransferFn.mock.calls[i][0].rwOnceBytes +
              dataTransferFn.mock.calls[i - 1][0].consumedBytes
        ).toBe(true);
      }

      const lastData = dataTransferFn.mock.calls[dataTransferCallLen - 2][0];
      expect(
        lastData.type === DataTransferType.Rw &&
          lastData.consumedBytes === lastData.totalBytes
      ).toBe(true);
      expect(
        dataTransferFn.mock.calls[dataTransferCallLen - 1][0].type ===
          DataTransferType.Succeed
      ).toBe(true);
    },
    NEVER_TIMEOUT
  );

  it(
    'downloadFile empty object dataTransfer and progress',
    async () => {
      const client = new TOS(tosOptions);
      const progressFn = jest.fn();
      const dataTransferFn = jest.fn();
      const filePath = path.resolve(
        downloadFileDir,
        'empty-object-dataTransfer and progress'
      );
      await client.downloadFile({
        key: objectKeyEmpty,
        filePath,
        dataTransferStatusChange: dataTransferFn,
        progress: progressFn,
      });

      expect(progressFn.mock.calls[0][0]).toEqual(0);
      expect(progressFn.mock.calls.filter((it) => it[0] === 1).length).toEqual(
        1
      );
      const lastCall = progressFn.mock.calls.slice(-1)[0];
      expect(lastCall[0]).toEqual(1);

      const totalBytes = 0;
      expect(
        dataTransferFn.mock.calls[0][0].type === DataTransferType.Started
      ).toBe(true);
      expect(dataTransferFn.mock.calls[0][0].totalBytes === totalBytes).toBe(
        true
      );
      expect(dataTransferFn.mock.calls.length).toEqual(2);
      expect(
        dataTransferFn.mock.calls[1][0].type === DataTransferType.Succeed
      ).toBe(true);
    },
    NEVER_TIMEOUT
  );

  it(
    'downloadFile 10M with download event-partSize=7177B',
    async () => {
      const client = new TOS(tosOptions);
      const downloadEventFn = jest.fn();
      const filePath = path.resolve(
        downloadFileDir,
        '10M-download event-partSize=7177B'
      );
      const totalBytes = 10 * 1024 * 1024;
      await client.downloadFile({
        key: objectKey10M,
        filePath,
        taskNum: 10,
        partSize: 7177,
        downloadEventChange: downloadEventFn,
      });
      const downloadEventFnCallsLen = downloadEventFn.mock.calls.length;
      expect(downloadEventFn.mock.calls[0][0].type).toBe(
        DownloadEventType.CreateTempFileSucceed
      );
      let totalEventBytes = 0;
      for (let i = 1; i < downloadEventFnCallsLen - 1; ++i) {
        const event: DownloadEvent = downloadEventFn.mock.calls[i][0];
        expect(event.type).toBe(DownloadEventType.DownloadPartSucceed);
        const partInfo = event.downloadPartInfo!;
        totalEventBytes += partInfo.rangeEnd - partInfo.rangeStart + 1;
      }
      expect(totalEventBytes).toBe(totalBytes);
      expect(
        downloadEventFn.mock.calls[downloadEventFnCallsLen - 1][0].type
      ).toBe(DownloadEventType.RenameTempFileSucceed);
    },
    NEVER_TIMEOUT
  );

  it(
    'downloadFile 10M cancal',
    async () => {
      const client = new TOS(tosOptions);
      const progressFn = jest.fn();
      const dataTransferFn = jest.fn();
      const downloadEventChangeFn = jest.fn();
      const filePath = path.resolve(downloadFileDir, '10M-cancel');

      const cancelTokenSource = CancelToken.source();
      // cancal after 5s
      setTimeout(() => {
        cancelTokenSource.cancel();
      }, 5_000);
      try {
        await client.downloadFile({
          key: objectKey10M,
          filePath,
          taskNum: 10,
          dataTransferStatusChange: dataTransferFn,
          progress: progressFn,
          downloadEventChange: downloadEventChangeFn,
          partSize: 7177,
          cancelToken: cancelTokenSource.token,
        });
        expect('').toBe('not enter this branch');
      } catch (err) {
        expect(isCancel(err)).toBeTruthy();
        const dataTransferStatusChangeCallsLen =
          dataTransferFn.mock.calls.length;
        const progressCallsLen = progressFn.mock.calls.length;
        const downloadEventChangeCallsLen =
          downloadEventChangeFn.mock.calls.length;
        // expect: don't receive new callbacks after cancel error
        await sleepCache(10_000);
        expect(dataTransferFn.mock.calls.length).toBe(
          dataTransferStatusChangeCallsLen
        );
        expect(progressFn.mock.calls.length).toBe(progressCallsLen);
        expect(downloadEventChangeFn.mock.calls.length).toBe(
          downloadEventChangeCallsLen
        );
      }
    },
    NEVER_TIMEOUT
  );

  it(
    'downloadFile with customTempFilePath & customRenameFileAfterDownloadCompleted ',
    async () => {
      const client = new TOS(tosOptions);

      const filePath = path.resolve(downloadFileDir, '10M');
      const tempFilePath = path.resolve(
        downloadFileDir,
        '10M-customTempAndRename.temp'
      );
      const renamePath = path.resolve(
        downloadFileDir,
        '10M-customTempAndRename'
      );
      await client.downloadFile({
        key: objectKey10M,
        filePath,
        tempFilePath,
        taskNum: 10,
        customRenameFileAfterDownloadCompleted: async (temp, target) => {
          expect(temp).toBe(tempFilePath);
          expect(target).toBe(filePath);
          await fsp.rename(tempFilePath, renamePath);
        },
        partSize: 1 * 1024 * 1024,
      });

      expect(fs.existsSync(renamePath)).toBe(true);
    },
    NEVER_TIMEOUT
  );
});
