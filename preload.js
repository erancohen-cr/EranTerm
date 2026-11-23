const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = ch => cb => ipcRenderer.on(ch, (_e, ...a) => cb(...a));

contextBridge.exposeInMainWorld('api', {
  pathForFile: f => webUtils.getPathForFile(f), // drag & drop upload
  servers: {
    list: () => ipcRenderer.invoke('servers:list'),
    save: s => ipcRenderer.invoke('servers:save', s),
    delete: id => ipcRenderer.invoke('servers:delete', id),
    setLogPaths: (id, paths) => ipcRenderer.invoke('servers:setLogPaths', id, paths),
    setAlerts: (id, alerts) => ipcRenderer.invoke('servers:setAlerts', id, alerts),
  },
  groups: {
    list: () => ipcRenderer.invoke('groups:list'),
    save: (oldName, name, color) => ipcRenderer.invoke('groups:save', oldName, name, color),
    colors: () => ipcRenderer.invoke('groups:colors'),
    delete: name => ipcRenderer.invoke('groups:delete', name),
  },
  users: {
    list: () => ipcRenderer.invoke('users:list'),
    save: u => ipcRenderer.invoke('users:save', u),
    delete: id => ipcRenderer.invoke('users:delete', id),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    setAi: a => ipcRenderer.invoke('settings:setAi', a), // { provider, key?, model }
    setAutoUpdate: on => ipcRenderer.invoke('settings:setAutoUpdate', on),
    setLog: a => ipcRenderer.invoke('settings:setLog', a), // { logToFile, logDir }
    pickLogDir: cur => ipcRenderer.invoke('settings:pickLogDir', cur),
    setAvail: a => ipcRenderer.invoke('settings:setAvail', a), // { on, intervalSec }
  },
  avail: {
    get: () => ipcRenderer.invoke('avail:get'),
    onUpdate: on('avail:update'),
  },
  log: {
    all: () => ipcRenderer.invoke('log:all'),
    clear: () => ipcRenderer.send('log:clear'),
    openFolder: () => ipcRenderer.invoke('log:openFolder'),
    openConsole: () => ipcRenderer.send('log:openConsole'),
    onLine: on('log:line'),
  },
  ssh: {
    connect: serverId => ipcRenderer.invoke('ssh:connect', serverId),
    disconnect: connId => ipcRenderer.send('ssh:disconnect', connId),
    shell: (connId, cols, rows, cwd) => ipcRenderer.invoke('ssh:shell', connId, cols, rows, cwd),
    write: (id, d) => ipcRenderer.send('ssh:write', id, d),
    resize: (id, c, r) => ipcRenderer.send('ssh:resize', id, c, r),
    closeShell: id => ipcRenderer.send('ssh:closeShell', id),
    metrics: connId => ipcRenderer.invoke('ssh:metrics', connId),
    top: (connId, sortBy) => ipcRenderer.invoke('ssh:top', connId, sortBy),
    os: connId => ipcRenderer.invoke('ssh:os', connId),
    kill: (connId, pid, force) => ipcRenderer.invoke('ssh:kill', connId, pid, force),
    onData: on('ssh:data'),
    onClosed: on('ssh:closed'),
    onConnClosed: on('ssh:connClosed'),
    onHostKeyReplaced: on('ssh:hostKeyReplaced'),
  },
  maint: {
    dropCaches: connId => ipcRenderer.invoke('maint:dropCaches', connId),
    scanDisk: connId => ipcRenderer.invoke('maint:scanDisk', connId),
    cleanDisk: (connId, ids) => ipcRenderer.invoke('maint:cleanDisk', connId, ids),
  },
  sftp: {
    list: (connId, dir) => ipcRenderer.invoke('sftp:list', connId, dir),
    mkdir: (connId, dir) => ipcRenderer.invoke('sftp:mkdir', connId, dir),
    delete: (connId, p) => ipcRenderer.invoke('sftp:delete', connId, p),
    download: (connId, p, isDir, xferId) => ipcRenderer.invoke('sftp:download', connId, p, isDir, xferId),
    upload: (connId, dir, locals, xferId) => ipcRenderer.invoke('sftp:upload', connId, dir, locals, xferId),
    onProgress: on('sftp:progress'),
  },
  logs: {
    read: (connId, file, n) => ipcRenderer.invoke('logs:read', connId, file, n),
    tail: (connId, file, n) => ipcRenderer.invoke('logs:tail', connId, file, n),
    stop: id => ipcRenderer.send('logs:stop', id),
    onData: on('logs:data'),
    onEnd: on('logs:end'),
  },
  scripts: {
    list: () => ipcRenderer.invoke('scripts:list'),
    save: sc => ipcRenderer.invoke('scripts:save', sc),
    delete: id => ipcRenderer.invoke('scripts:delete', id),
    reorder: ids => ipcRenderer.invoke('scripts:reorder', ids),
    restoreBuiltins: () => ipcRenderer.invoke('scripts:restoreBuiltins'),
    import: () => ipcRenderer.invoke('scripts:import'),
    export: () => ipcRenderer.invoke('scripts:export'),
  },
  deploy: {
    list: () => ipcRenderer.invoke('deploy:list'),
    save: d => ipcRenderer.invoke('deploy:save', d),
    delete: id => ipcRenderer.invoke('deploy:delete', id),
    pickFiles: () => ipcRenderer.invoke('deploy:pickFiles'),
    run: d => ipcRenderer.invoke('deploy:run', d),
    cancel: runId => ipcRenderer.send('deploy:cancel', runId),
    onEvent: on('deploy:event'),
  },
  rdp: { open: serverId => ipcRenderer.invoke('rdp:open', serverId) },
  remote: { open: serverId => ipcRenderer.invoke('remote:open', serverId) },
  ai: {
    suggest: (connId, req) => ipcRenderer.invoke('ai:suggest', connId, req),
    analyze: (connId, a) => ipcRenderer.invoke('ai:analyze', connId, a), // { kind: 'logs'|'terminal', question, text, source }
    models: a => ipcRenderer.invoke('ai:models', a), // { provider, key? }
    test: a => ipcRenderer.invoke('ai:test', a),     // { provider, key?, model? }
  },
});
