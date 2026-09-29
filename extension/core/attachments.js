'use strict';
// Files the phone may read besides the session folders: the pictures and files pasted into a chat,
// which VS Code keeps under <userData>/agentSessionData/<session id>/attachments/.
const path = require('path');

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
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
    if (id && isInside(path.resolve(file), path.join(base, id, 'attachments'))) return true;
  }
  return false;
}

module.exports = { isInside, sessionIdOf, isSessionAttachment };
