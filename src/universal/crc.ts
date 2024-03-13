import * as browserCRC from './crc.browser';
import * as nodejsCRC from '../nodejs/crc.node';

type CRCModule = typeof nodejsCRC;
export type CRCCls = nodejsCRC.CRC;
let crcModule = null as unknown as CRCModule;

if (process.env.TARGET_ENVIRONMENT === 'node') {
  crcModule = nodejsCRC;
} else {
  crcModule = browserCRC as unknown as CRCModule;
}

const { CRC, combineCrc64 } = crcModule;
export { CRC, combineCrc64 };
