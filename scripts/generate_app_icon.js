const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico');

async function ensureDir(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
}

async function generateIcoFromSvg(svgPath, outputIcoPath) {
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const pngBuffers = await Promise.all(
        sizes.map((size) =>
            sharp(svgPath)
                .resize(size, size, { fit: 'contain' })
                .png()
                .toBuffer()
        )
    );

    const icoBuffer = await pngToIco(pngBuffers);
    await ensureDir(path.dirname(outputIcoPath));
    await fs.writeFile(outputIcoPath, icoBuffer);
}

async function main() {
    const rootDir = path.resolve(__dirname, '..');
    const sourceSvg = path.join(rootDir, 'images', 'STP_icon.svg');
    const rootIco = path.join(rootDir, 'images', 'STP_icon.ico');
    const releaseIco = path.join(rootDir, 'release', 'StormTrack Pro-win32-x64', 'resources', 'app', 'STP_icon.ico');

    await generateIcoFromSvg(sourceSvg, rootIco);
    try {
        await fs.access(path.dirname(releaseIco));
        await fs.copyFile(rootIco, releaseIco);
    } catch (_) {
        // release directory doesn't exist yet; skip copy
    }
}

main().catch((err) => {
    console.error('Failed generating STP_icon.ico:', err);
    process.exit(1);
});
