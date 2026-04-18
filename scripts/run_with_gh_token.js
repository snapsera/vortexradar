const { execFileSync, spawnSync } = require('child_process');

function readWindowsEnv(varName, target) {
    try {
        const output = execFileSync(
            'powershell',
            [
                '-NoProfile',
                '-Command',
                `[System.Environment]::GetEnvironmentVariable('${varName}', '${target}')`,
            ],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        );
        const value = output.trim();
        return value || null;
    } catch (_) {
        return null;
    }
}

function ensureGithubToken() {
    if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
        return true;
    }

    if (process.platform === 'win32') {
        const fromUser = readWindowsEnv('GH_TOKEN', 'User') || readWindowsEnv('GITHUB_TOKEN', 'User');
        const fromMachine = readWindowsEnv('GH_TOKEN', 'Machine') || readWindowsEnv('GITHUB_TOKEN', 'Machine');
        const token = fromUser || fromMachine;

        if (token) {
            process.env.GH_TOKEN = token;
            return true;
        }
    }

    return false;
}

function main() {
    const command = process.argv[2];
    const args = process.argv.slice(3);

    if (!command) {
        console.error('FAIL: Missing command. Usage: node scripts/run_with_gh_token.js <command> [...args]');
        process.exit(1);
    }

    if (!ensureGithubToken()) {
        console.error('FAIL: GH_TOKEN is not available. Set it once with setx GH_TOKEN "<token>" and restart Cursor.');
        process.exit(1);
    }

    const result = spawnSync(command, args, {
        shell: true,
        stdio: 'inherit',
        env: process.env,
    });

    process.exit(typeof result.status === 'number' ? result.status : 1);
}

main();
