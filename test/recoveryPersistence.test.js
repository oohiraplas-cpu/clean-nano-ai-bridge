const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TaskStore } = require('../src/taskStore');
const { getConfig } = require('../src/config');
test('Azure task cache is outside deployed package', () => {
 assert.equal(getConfig({WEBSITE_SITE_NAME:'clean-nano-ai-bridge'}).tasksFile, '/home/clean-nano/tasks.json');
 assert.equal(getConfig({WEBSITE_SITE_NAME:'x', TASKS_FILE:'/home/custom/tasks.json'}).tasksFile, '/home/custom/tasks.json');
});
test('task survives fresh store instance and creates missing directory', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(),'cn-recovery-'));
 try {
 const file = path.join(dir,'persistent','tasks.json');
 assert.deepEqual(await new TaskStore(file).list(), []);
 await new TaskStore(file).upsert({id:'persist-1',title:'復旧',status:'未着手'});
 const restarted = new TaskStore(file);
 assert.equal((await restarted.list())[0].id, 'persist-1');
 await restarted.update('persist-1',{status:'完了'});
 assert.equal((await new TaskStore(file).list())[0].status, '完了');
 assert.deepEqual(await fs.readdir(path.dirname(file)), ['tasks.json']);
 } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test('corrupt cache is not silently reset', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(),'cn-corrupt-'));
 try {
 const file = path.join(dir,'tasks.json'); await fs.writeFile(file,'broken');
 await assert.rejects(new TaskStore(file).upsert({id:'x',title:'x'}));
 assert.equal(await fs.readFile(file,'utf8'),'broken');
 } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
