const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8787);

async function waitForServer(url, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Local dashboard did not start at ${url}`);
}

async function createWindow() {
  const dataDir = app.getPath('userData');
  process.env.JEV_GUARD_DATA_DIR = dataDir;
  process.env.JEV_GUARD_ENV_FILE = path.join(dataDir, '.env');
  process.env.NO_AUTO_BROWSER = 'true';
  await import('./server.mjs');
  const url = `http://127.0.0.1:${PORT}`;
  await waitForServer(url);
  const window = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1050,
    minHeight: 700,
    title: 'WhatsApp Jev Guard',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await window.loadURL(url);
}

app.whenReady().then(createWindow).catch((error) => {
  console.error(error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
