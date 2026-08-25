const { execSync } = require('child_process');

const portArg = process.argv[2];
const port = Number(portArg || 9191);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`Invalid port: ${portArg}`);
    process.exit(1);
}

function getListeningPids(targetPort) {
    const output = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
    const pids = new Set();
    const suffix = `:${targetPort}`;

    for (const line of output.split(/\r?\n/)) {
        if (!line.includes('LISTENING') || !line.includes(suffix)) continue;
        const parts = line.trim().split(/\s+/);
        const localAddress = parts[1];
        const state = parts[3];
        const pid = Number(parts[4]);
        if (!localAddress || !state || !Number.isInteger(pid)) continue;
        if (!localAddress.endsWith(suffix)) continue;
        if (state !== 'LISTENING') continue;
        pids.add(pid);
    }

    return [...pids];
}

function getParentPidMap() {
    try {
        const json = execSync(
            'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"',
            { encoding: 'utf8' },
        ).trim();

        if (!json) return new Map();
        const parsed = JSON.parse(json);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        const parentMap = new Map();

        for (const row of rows) {
            const pid = Number(row.ProcessId);
            const parentPid = Number(row.ParentProcessId);
            if (Number.isInteger(pid) && Number.isInteger(parentPid)) {
                parentMap.set(pid, parentPid);
            }
        }

        return parentMap;
    } catch (err) {
        return new Map();
    }
}

function collectAncestorPids(seedPids) {
    const parentMap = getParentPidMap();
    const killSet = new Set(seedPids);
    const scriptPid = process.pid;

    for (const seedPid of seedPids) {
        let current = seedPid;
        const seen = new Set();

        while (parentMap.has(current)) {
            const parent = parentMap.get(current);
            if (!Number.isInteger(parent) || parent <= 0) break;
            if (parent === scriptPid) break;
            if (seen.has(parent)) break;
            seen.add(parent);
            killSet.add(parent);
            current = parent;
        }
    }

    return [...killSet];
}

function killPid(pid) {
    try {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'pipe' });
        return true;
    } catch (err) {
        const stderr = String(err.stderr || '');
        const stdout = String(err.stdout || '');
        const notFound =
            stdout.includes('not found') ||
            stderr.includes('not found') ||
            stdout.includes('not running') ||
            stderr.includes('not running');
        if (notFound) return true;
        return false;
    }
}

function sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const deadline = Date.now() + 12000;
while (Date.now() < deadline) {
    const listeners = getListeningPids(port);
    if (listeners.length === 0) {
        process.exit(0);
    }

    const pidsToKill = collectAncestorPids(listeners);
    for (const pid of pidsToKill) {
        killPid(pid);
    }

    sleep(200);
}

const remaining = getListeningPids(port);
if (remaining.length > 0) {
    console.error(`Port ${port} is still busy (PID(s): ${remaining.join(', ')})`);
    process.exit(1);
}
