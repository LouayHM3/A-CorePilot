const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist', 'webview');
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(
  path.join(root, 'webview-ui', 'src', 'styles', 'index.css'),
  path.join(output, 'index.css')
);
console.log('Copied webview stylesheet to dist/webview/index.css');
