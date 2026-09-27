import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { existsSync, writeFileSync } from 'node:fs';

const target = new URL('../.dev.vars', import.meta.url);
if (existsSync(target)) {
  console.log('保留既有 .dev.vars，未讀取或覆寫。');
} else {
  writeFileSync(target, `AUTH_SECRET=${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  console.log('已建立本機 .dev.vars；密鑰不顯示於輸出，請勿提交 Git。');
}
