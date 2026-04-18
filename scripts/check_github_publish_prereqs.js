const fs = require('fs');
const path = require('path');

function fail(message) {
    console.error(`FAIL: ${message}`);
}

function pass(message) {
    console.log(`PASS: ${message}`);
}

function info(message) {
    console.log(`INFO: ${message}`);
}

function getPublishTarget() {
    const packageJsonPath = path.join(__dirname, '..', 'package.json');
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw);
    const publishConfig = pkg?.build?.publish;
    const githubConfig = Array.isArray(publishConfig)
        ? publishConfig.find((entry) => entry?.provider === 'github')
        : publishConfig?.provider === 'github'
            ? publishConfig
            : null;

    if (!githubConfig?.owner || !githubConfig?.repo) {
        throw new Error('No GitHub publish target found in package.json build.publish');
    }
    return {
        owner: githubConfig.owner,
        repo: githubConfig.repo,
    };
}

async function githubRequest(url, token) {
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'vortexradar-preflight',
        },
    });

    let body = null;
    try {
        body = await response.json();
    } catch (_) {
        body = null;
    }

    return { response, body };
}

async function main() {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    const tokenSource = process.env.GH_TOKEN ? 'GH_TOKEN' : process.env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : null;
    let hadError = false;

    if (!token) {
        fail('Missing GH_TOKEN (or GITHUB_TOKEN).');
        info('Set one of these env vars before publishing.');
        process.exit(1);
    }

    pass(`Found token in ${tokenSource}.`);

    const { owner, repo } = getPublishTarget();
    info(`Publish target from package.json: ${owner}/${repo}`);

    const userResult = await githubRequest('https://api.github.com/user', token);
    if (!userResult.response.ok || !userResult.body?.login) {
        fail(`Token validation failed (status ${userResult.response.status}).`);
        hadError = true;
    } else {
        pass(`Token is valid for GitHub user "${userResult.body.login}".`);
    }

    const repoUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const repoResult = await githubRequest(repoUrl, token);
    if (!repoResult.response.ok) {
        fail(`Cannot access repo ${owner}/${repo} (status ${repoResult.response.status}).`);
        hadError = true;
    } else {
        pass(`Can access repo ${owner}/${repo}.`);
        const permissions = repoResult.body?.permissions;
        if (!permissions) {
            info('Could not read permission flags from API response; verify token scopes manually.');
        } else if (permissions.admin || permissions.maintain || permissions.push) {
            pass('Token has write-capable repo permission (admin/maintain/push).');
        } else {
            fail('Token does not appear to have write permission for this repo.');
            hadError = true;
        }
    }

    const releasesUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=1`;
    const releasesResult = await githubRequest(releasesUrl, token);
    if (!releasesResult.response.ok) {
        fail(`Cannot query releases endpoint (status ${releasesResult.response.status}).`);
        hadError = true;
    } else {
        pass('Can query releases endpoint.');
    }

    if (hadError) {
        info('Preflight failed. Fix the issues above, then rerun npm run desktop:preflight.');
        process.exit(1);
    }

    pass('GitHub publish preflight passed. You can run npm run desktop:publish.');
}

main().catch((error) => {
    fail(error.message);
    process.exit(1);
});
