'use strict';
// Files the phone may read besides the session folders: the pictures and files pasted into a chat,
// which VS Code keeps under <userData>/agentSessionData/<session id>/attachments/.
const fs = require('fs');
const path = require('path');

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

// Where folders really are on disk, looked up at most once a minute per folder.
const realFolders = new Map();

/** A folder as the disk has it, links resolved (macOS keeps /tmp in /private/tmp, say). */
function realFolder(dir) {
  // A network share is taken at its address: looking it up could hold everything up while it answers.
  if (/^[\\/]{2}[^\\/]/.test(dir)) return dir;
  const hit = realFolders.get(dir);
  if (hit && Date.now() - hit.at < 60000) return hit.real;
  let real = dir;
  try {
    real = fs.realpathSync.native(dir);
  } catch {
    /* gone: its address is all there is */
  }
  realFolders.delete(dir);
  realFolders.set(dir, { real, at: Date.now() });
  if (realFolders.size > 500) realFolders.delete(realFolders.keys().next().value);
  return real;
}

/**
 * Whether the local path `file` is in the folder `dir`: by its address, or where the folder really is
 * (the relay checks where a link leads, which is the folder's real place for a folder reached by a link).
 */
function isInFolder(file, dir) {
  return isInside(file, dir) || isInside(file, realFolder(dir));
}

/** The session id in a session URI such as `copilotcli:/4699dd55-…`, which names its folder. */
function sessionIdOf(uri) {
  const m = /^[a-z][\w+.-]*:\/*([\w.-]+)\/?$/i.exec(String(uri || ''));
  return m && !/^\.+$/.test(m[1]) ? m[1] : null;
}

/** Whether `file` (a local path) was attached to one of the sessions in `sessionUris`. */
function isSessionAttachment(file, userData, sessionUris) {
  if (!file || !userData) return false;
  const base = path.join(userData, 'agentSessionData');
  for (const uri of sessionUris || []) {
    const id = sessionIdOf(uri);
    if (id && isInFolder(path.resolve(file), path.join(base, id, 'attachments'))) return true;
  }
  return false;
}

module.exports = { isInside, isInFolder, realFolder, sessionIdOf, isSessionAttachment };
