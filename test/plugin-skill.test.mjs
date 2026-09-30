import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMMAND_DESCRIPTION, installSkill, managedVersion, skillFile, skillText } from '../copilot-plugin/com.github.copilot/extensions/pocket-pilot/lib/skill.mjs';

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp-skill-'));

test('/pocket-pilot skill: lives in the Copilot home the runtime uses', () => {
  const saved = process.env.COPILOT_HOME;
  try {
    process.env.COPILOT_HOME = path.join(os.tmpdir(), 'copilot-home');
    assert.equal(skillFile(), path.join(os.tmpdir(), 'copilot-home', 'skills', 'pocket-pilot', 'SKILL.md'));
    delete process.env.COPILOT_HOME;
    assert.equal(skillFile(), path.join(os.homedir(), '.copilot', 'skills', 'pocket-pilot', 'SKILL.md'));
  } finally {
    if (saved === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = saved;
  }
});

test('/pocket-pilot skill: a user-invocable skill that hands over to the pocket_pilot tool', () => {
  const text = skillText('1.2.3', '/home/me/.copilot/skills/pocket-pilot');
  const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) || [];
  assert.ok(front, 'starts with frontmatter');
  const meta = Object.fromEntries(front.split('\n').map((l) => /^([\w-]+): (".*")$/.exec(l)).map((m) => [m[1], JSON.parse(m[2])]));
  assert.deepEqual(meta, { name: 'pocket-pilot', description: COMMAND_DESCRIPTION, 'argument-hint': '[pair | status | off]' });
  assert.equal(managedVersion(text), '1.2.3');
  for (const action of ['pair', 'status', 'off']) assert.match(body, new RegExp(`\\{"action": "${action}"\\}`));
  assert.match(body, /\/home\/me\/\.copilot\/skills\/pocket-pilot/, 'says where it lives, for when the plugin is gone');
});

test('/pocket-pilot skill: created, kept up to date, never downgraded', () => {
  const home = tempHome();
  const file = skillFile(home);
  try {
    assert.equal(installSkill({ version: '0.7.6', file }), 'created');
    assert.equal(managedVersion(fs.readFileSync(file, 'utf8')), '0.7.6');
    assert.equal(installSkill({ version: '0.7.6', file }), 'current');
    assert.equal(installSkill({ version: '0.8.0', file }), 'updated');
    assert.equal(managedVersion(fs.readFileSync(file, 'utf8')), '0.8.0');
    // A chat still running the older version must not undo the update.
    assert.equal(installSkill({ version: '0.7.6', file }), 'kept');
    assert.equal(managedVersion(fs.readFileSync(file, 'utf8')), '0.8.0');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['SKILL.md'], 'no temp files left behind');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('/pocket-pilot skill: leaves a skill the user wrote or took over alone', () => {
  const home = tempHome();
  const file = skillFile(home);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const own = '---\nname: pocket-pilot\ndescription: my own\n---\n\nMine.\n';
    fs.writeFileSync(file, own);
    assert.equal(installSkill({ version: '0.7.6', file }), 'kept');
    assert.equal(fs.readFileSync(file, 'utf8'), own);
    // Deleting the marker line, as the file says, keeps an edited copy.
    fs.writeFileSync(file, skillText('0.7.6', path.dirname(file)).replace(/^<!-- pocket-pilot-plugin .*\n/m, '').replace('Pocket Pilot shows', 'My Pocket Pilot shows'));
    const edited = fs.readFileSync(file, 'utf8');
    assert.equal(installSkill({ version: '0.8.0', file }), 'kept');
    assert.equal(fs.readFileSync(file, 'utf8'), edited);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('/pocket-pilot skill: a failure never throws', () => {
  const home = tempHome();
  try {
    fs.writeFileSync(path.join(home, 'skills'), 'not a folder');
    assert.equal(installSkill({ version: '0.7.6', file: skillFile(home) }), 'failed');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
