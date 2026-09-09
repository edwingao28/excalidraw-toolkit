import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const cli=new URL('../bin/cli.js',import.meta.url).pathname;
test('CLI installs and removes project skills without changing user MCP configuration', t=>{
 const dir=mkdtempSync(join(tmpdir(),'toolkit-agent-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const home=join(dir,'home');const project=join(dir,'project');mkdirSync(home);mkdirSync(project);
 const config=join(home,'.claude.json');const bytes='{"mcpServers":{"other":{"command":"existing"}}}\n';writeFileSync(config,bytes);
 const args=['--target','all','--project',project,'--home',home];
 const run=command=>JSON.parse(execFileSync(process.execPath,[cli,command,...args],{encoding:'utf8'}));
 const installed=run('init');assert.equal(installed.ownedPaths.length,2);
 assert.deepEqual(installed.codexMcp.args,[cli,'mcp','--project',realpathSync(project)]);assert.equal(installed.codexMcp.command,process.execPath);assert.equal(installed.codexMcp.configured,false);
 assert.equal(existsSync(join(project,'.codex','config.toml')),false);
 for(const path of installed.ownedPaths){const text=readFileSync(path,'utf8');assert.ok(text.includes(cli));assert.ok(!text.includes('{{CLI_COMMAND}}'));}
 assert.equal(readFileSync(config,'utf8'),bytes);
 const removed=run('uninstall');assert.equal(removed.removedPaths.length,2);assert.ok(removed.removedPaths.every(path=>!existsSync(path)));
 assert.equal(readFileSync(config,'utf8'),bytes);
});
