const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('todo', {
  list: () => ipcRenderer.invoke('todo:list'),
  mutate: input => ipcRenderer.invoke('todo:mutate', input),
  control: action => ipcRenderer.invoke('todo:window', action),
  theme: () => ipcRenderer.invoke('todo:theme'),
  onTheme: listener => { const handler = (_event, theme) => listener(theme); ipcRenderer.on('todo:theme', handler); return () => ipcRenderer.off('todo:theme', handler); },
});
