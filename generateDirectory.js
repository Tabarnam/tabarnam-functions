const fs = require('fs');
const path = require('path');

function listDir(dir, prefix = '') {
    let result = '';
    let files;
    try {
        files = fs.readdirSync(dir, { withFileTypes: true })
            .filter(f => !['node_modules', '.git', 'generateDirectory.js'].includes(f.name));
    } catch (err) {
        console.error('Error reading directory:', dir, err);
        return '';
    }
    files.forEach((file, idx) => {
        const isLast = idx === files.length - 1;
        const pointer = isLast ? '└── ' : '├── ';
        result += `${prefix}${pointer}${file.name}\n`;
        if (file.isDirectory()) {
            const nextPrefix = prefix + (isLast ? '    ' : '│   ');
            result += listDir(path.join(dir, file.name), nextPrefix);
        }
    });
    return result;
}

function writeDirectoryFile() {
    try {
        const rootDir = __dirname;
        const output = `# Project Directory Structure\n\n\`\`\`\n${path.basename(rootDir)}/\n${listDir(rootDir)}\`\`\`\n`;
        fs.writeFileSync(path.join(rootDir, 'DIRECTORY.md'), output);
        console.log('DIRECTORY.md updated!');
    } catch (err) {
        console.error('Error writing DIRECTORY.md:', err);
    }
}

// Initial write
writeDirectoryFile();

// Watch for changes in the directory
fs.watch(__dirname, { recursive: true }, (eventType, filename) => {
    if (filename && !filename.endsWith('DIRECTORY.md')) {
        console.log(`Change detected: ${filename}`);
        writeDirectoryFile();
    }
});

console.log('Watching for changes...');