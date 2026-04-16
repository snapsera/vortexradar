const fs = require('fs');
const path = require('path');

const order = [
    'variables', 'base', 'layout', 'header', 'toolbar', 'screenshot', 'menu',
    'alerts', 'footer', 'dialog', 'product-menu', 'forms', 'devtools', 'auto-coverage', 'forecast', 'spc_outlooks', 'live_mode', 'misc'
];

const stylesDir = path.join(__dirname, '..', 'styles');
const outFile = path.join(__dirname, '..', 'index.css');

let output = '';
for (const name of order) {
    const filePath = path.join(stylesDir, name + '.css');
    const content = fs.readFileSync(filePath, 'utf8');
    output += `/* ========== styles\\${name}.css ========== */\n${content}\n`;
}

fs.writeFileSync(outFile, output, 'utf8');
console.log('index.css rebuilt successfully.');
