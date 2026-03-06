import { initDatabase, setRegisteredGroup } from '../src/db.js';
import fs from 'fs';
import path from 'path';

initDatabase();
setRegisteredGroup('feishu:oc_7f497eccee4dcdba349a7998bb082f52', {
  name: 'Feishu Main',
  folder: 'feishu_main',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
fs.mkdirSync(path.join('groups', 'feishu_main', 'logs'), { recursive: true });
console.log('Registered feishu:oc_7f497eccee4dcdba349a7998bb082f52 as feishu_main');
