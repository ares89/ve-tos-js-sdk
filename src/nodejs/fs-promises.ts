/**
 * since fs/promises exist after nodejs@14, so we make own fs/promises
 */
import fs from 'fs';
import fsPromises from 'fs/promises';
import { promisify } from 'util';

export const createWriteStream = fs.createWriteStream;
export const createReadStream = fs.createReadStream;
export const open = fsPromises.open;
export const close = promisify(fs.close);
export const rename = promisify(fs.rename);
export const stat = promisify(fs.stat);
export const mkdir = promisify(fs.mkdir);
export const writeFile = promisify(fs.writeFile);
export const write = promisify(fs.write);
export const appendFile = promisify(fs.appendFile);
// fs.rm was added v14.14.0, so use fs.unlink
export const rm = promisify(fs.unlink);
export const readFile = promisify(fs.readFile);

export const safeMkdirRecursive = async (dirName: fs.PathLike) => {
  try {
    await fsPromises.access(dirName);
  } catch (e) {
    await fsPromises.mkdir(dirName, { recursive: true });
  }
};
