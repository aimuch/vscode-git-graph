/**
 * End-to-End Test Suite - Runs inside the Extension Host of a real instance of Visual Studio Code (see ./run.js).
 *
 * The checks drive Git Graph the way a user does (running its commands, and the messages exchanged between the
 * Git Graph View's Webview and the extension), against real Git repositories. Each check writes its result to the
 * report, so that the run can be verified & repeated.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const fixtures = JSON.parse(process.env.E2E_FIXTURES);
const results = [];

const GIT_ENV = Object.assign({}, process.env, {
	GIT_AUTHOR_NAME: 'E2E Author', GIT_AUTHOR_EMAIL: 'author@example.com',
	GIT_COMMITTER_NAME: 'E2E Committer', GIT_COMMITTER_EMAIL: 'committer@example.com'
});

function git(cwd, ...args) {
	return cp.execFileSync('git', args, { cwd: cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(description, condition, timeout = 20000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const value = await condition();
		if (value) return value;
		await sleep(100);
	}
	throw new Error('Timed out waiting for ' + description);
}

function withTimeout(promise, ms, description) {
	return Promise.race([promise, sleep(ms).then(() => { throw new Error('Timed out after ' + ms + 'ms: ' + description); })]);
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function check(id, title, fn) {
	const start = Date.now();
	try {
		const details = await fn();
		results.push({ id: id, title: title, pass: true, details: details || '', durationMs: Date.now() - start });
	} catch (err) {
		results.push({ id: id, title: title, pass: false, details: err && err.stack ? err.stack : String(err), durationMs: Date.now() - start });
	}
}

function realpath(p) {
	return fs.realpathSync(p).replace(/\\/g, '/');
}

/**
 * Instrument the Git Graph View, recording the messages exchanged between its Webview and the extension.
 */
function instrumentGitGraphView(extensionPath) {
	const { GitGraphView } = require(path.join(extensionPath, 'out', 'gitGraphView.js'));
	const record = { requests: [], responses: [], html: [] };

	const respondToMessage = GitGraphView.prototype.respondToMessage;
	GitGraphView.prototype.respondToMessage = function (msg) {
		record.requests.push(msg);
		return respondToMessage.call(this, msg);
	};
	const sendMessage = GitGraphView.prototype.sendMessage;
	GitGraphView.prototype.sendMessage = function (msg) {
		record.responses.push(msg);
		return sendMessage.call(this, msg);
	};
	const getHtmlForWebview = GitGraphView.prototype.getHtmlForWebview;
	GitGraphView.prototype.getHtmlForWebview = function () {
		const html = getHtmlForWebview.call(this);
		record.html.push(html);
		return html;
	};

	return { GitGraphView, record };
}

function getGitGraphTabs() {
	return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.label === 'Git Graph');
}

/**
 * Wait for the Webview to request (and the extension to respond with) the commits of a repository.
 */
async function waitForCommitsLoaded(record, repo, sinceIndex) {
	await waitFor('the Webview to request the commits of ' + repo, () => record.requests.slice(sinceIndex.requests).some((msg) => msg.command === 'loadCommits' && msg.repo === repo));
	return waitFor('the extension to respond with the commits of ' + repo, () => {
		const request = record.requests.slice(sinceIndex.requests).reverse().find((msg) => msg.command === 'loadCommits' && msg.repo === repo);
		return record.responses.slice(sinceIndex.responses).reverse().find((msg) => msg.command === 'loadCommits' && msg.refreshId === request.refreshId);
	});
}

function marker(record) {
	return { requests: record.requests.length, responses: record.responses.length };
}

async function run() {
	const extension = vscode.extensions.getExtension('Andy.git-graph');
	assert(extension, 'The Git Graph extension is not loaded');
	const { GitGraphView, record } = instrumentGitGraphView(extension.extensionPath);
	await extension.activate();

	const main = realpath(fixtures.main), sub = realpath(fixtures.sub), wt = realpath(fixtures.wt);

	// Get the open Git Graph View (opening it if a previous check failed to), so that each check is independent of the others
	const getView = async () => {
		if (!GitGraphView.currentPanel) await vscode.commands.executeCommand('git-graph.view');
		return waitFor('the Git Graph View to open', () => GitGraphView.currentPanel);
	};

	await check('activation', 'Git Graph activates in this version of Visual Studio Code (onStartupFinished)', async () => {
		const packageJson = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, 'package.json'), 'utf8'));
		assert(extension.isActive, 'The extension is not active');
		assert(JSON.stringify(packageJson.activationEvents) === '["onStartupFinished"]', 'Unexpected activation events: ' + JSON.stringify(packageJson.activationEvents));
		return 'Visual Studio Code ' + vscode.version + ', engines.vscode ' + packageJson.engines.vscode;
	});

	await check('#903', '"View Git Graph" is contributed to the scm/repository menu (Source Control Repositories view)', async () => {
		const menus = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, 'package.json'), 'utf8')).contributes.menus;
		const repositoryMenu = menus['scm/repository'] || [];
		assert(repositoryMenu.some((item) => item.command === 'git-graph.view' && item.group === 'inline' && item.when.includes('\'Inline\'')), 'No inline scm/repository menu item');
		assert(repositoryMenu.some((item) => item.command === 'git-graph.view' && item.group !== 'inline' && item.when.includes('\'More Actions\'')), 'No "More Actions" scm/repository menu item');
	});

	await check('#794', 'The "View Git Graph" command opens the view when invoked with a null argument', async () => {
		const since = marker(record);
		await vscode.commands.executeCommand('git-graph.view', null);
		await waitFor('the Git Graph View to open', () => GitGraphView.currentPanel && getGitGraphTabs().length === 1, 10000);
		// The Webview's script runs & requests the repositories, i.e. the Webview's resources load in this version of Visual Studio Code
		await waitFor('the Webview to request data', () => record.requests.slice(since.requests).some((msg) => msg.command === 'loadRepoInfo'));
		return 'Webview requests: ' + Array.from(new Set(record.requests.map((msg) => msg.command))).join(', ');
	});

	await check('webview-csp', 'The Webview HTML loads its script & stylesheet through the Webview resource URIs and CSP of this version', async () => {
		await getView();
		const html = await waitFor('the Webview HTML', () => record.html.slice().reverse().find((html) => html.includes('id="view"')));
		assert(/<meta http-equiv="Content-Security-Policy" content="[^"]*script-src 'nonce-[^']+'/.test(html), 'No nonce based script-src CSP');
		const scriptSrc = (html.match(/<script nonce="[^"]+" src="([^"]+)">/) || [])[1];
		assert(scriptSrc && scriptSrc.includes('out.min.js') && !scriptSrc.startsWith('file:'), 'Unexpected script src: ' + scriptSrc);
		return 'script src: ' + scriptSrc;
	});

	await check('#668', 'Repositories, submodules and worktrees in the workspace are all discovered', async () => {
		const view = await getView();
		const repos = await waitFor('the repositories to be discovered', () => {
			const repos = Object.keys(view.repoManager.getRepos());
			return [main, sub, wt].every((repo) => repos.includes(repo)) ? repos : null;
		}).catch((err) => {
			throw new Error(err.message + '. Discovered: ' + Object.keys(view.repoManager.getRepos()).join(', '));
		});
		return 'Repositories: ' + repos.map((repo) => path.relative(realpath(fixtures.workspace), repo)).join(', ');
	});

	await check('#935', 'Commits after a commit whose subject contains a raw CR character are loaded (from the Webview)', async () => {
		await vscode.commands.executeCommand('git-graph.view', { rootUri: vscode.Uri.file(main) }); // As invoked from the Source Control View
		const response = await waitForCommitsLoaded(record, main, { requests: 0, responses: 0 }); // The repository may already have been loaded when the view was opened
		const hashes = response.commits.map((commit) => commit.hash);
		const crCommit = response.commits.find((commit) => commit.hash === fixtures.crCommit);
		assert(crCommit, 'The commit containing a raw CR character is missing');
		assert(crCommit.message.includes('\r'), 'The raw CR character was not preserved in the subject');
		assert(hashes.includes(fixtures.firstCommit), 'The commits before the CR commit are missing: loaded ' + hashes.length + ' commits');
		return 'Loaded ' + hashes.length + ' commits, including ' + fixtures.firstCommit.substring(0, 8) + ' (before the CR commit)';
	});

	await check('#940', 'Interactive rebase on a branch whose name contains shell syntax does not execute it', async () => {
		const dataSource = (await getView()).dataSource;
		assert(!fs.existsSync(fixtures.injectionMarker), 'The marker exists before the rebase');
		const reflogBefore = git(main, 'reflog', '--format=%gs').split('\n').length;
		const error = await dataSource.rebase(main, fixtures.injectionBranch, 'Branch', false, true);
		assert(error === null, 'Rebase returned an error: ' + error);
		const terminal = vscode.window.terminals.find((terminal) => terminal.name === 'Git Graph: Rebase on "' + fixtures.injectionBranch + '"');
		assert(terminal, 'The interactive rebase terminal was not opened');
		// The rebase runs in the Integrated Terminal, wait for it to finish
		await waitFor('the interactive rebase to finish', () => {
			assert(!fs.existsSync(fixtures.injectionMarker), 'The command substitution in the branch name was executed by the shell');
			const reflog = git(main, 'reflog', '--format=%gs').split('\n');
			return reflog.length > reflogBefore && reflog.some((entry) => /^rebase.*\(finish\)/.test(entry));
		}, 30000);
		await sleep(1000);
		assert(!fs.existsSync(fixtures.injectionMarker), 'The command substitution in the branch name was executed by the shell');
		return 'Rebase completed in the terminal, and the marker file was not created';
	});
	vscode.window.terminals.forEach((terminal) => terminal.dispose());

	await check('#708', 'Tags & branches that share a name can be deleted from and pushed to a remote', async () => {
		const dataSource = (await getView()).dataSource;
		const remoteRefs = () => git(main, 'ls-remote', 'origin').split('\n').map((line) => line.split('\t')[1]);

		let error = await dataSource.deleteTag(main, 'asd', 'origin');
		assert(error === null, 'Deleting the tag failed: ' + error);
		assert(!remoteRefs().includes('refs/tags/asd') && remoteRefs().includes('refs/heads/asd'), 'Unexpected remote refs after deleting the tag: ' + remoteRefs().join(', '));

		git(main, 'tag', 'asd', fixtures.crCommit);
		const errors = await dataSource.pushTag(main, 'asd', ['origin'], fixtures.crCommit, true);
		assert(errors.length === 1 && errors[0] === null, 'Pushing the tag failed: ' + errors.join(', '));
		assert(remoteRefs().includes('refs/tags/asd'), 'The tag was not pushed');

		git(main, 'branch', '-f', 'asd', fixtures.crCommit);
		error = await dataSource.pushBranch(main, 'asd', 'origin', false, '');
		assert(error === null, 'Pushing the branch failed: ' + error);
		assert(git(main, 'ls-remote', 'origin', 'refs/heads/asd').startsWith(fixtures.crCommit), 'The branch was not pushed');

		error = await dataSource.deleteRemoteBranch(main, 'asd', 'origin');
		assert(error === null, 'Deleting the remote branch failed: ' + error);
		assert(!remoteRefs().includes('refs/heads/asd') && remoteRefs().includes('refs/tags/asd'), 'Unexpected remote refs after deleting the branch: ' + remoteRefs().join(', '));
	});

	await check('#932', 'An externally configured GIT_ASKPASS is used for authentication instead of Git Graph\'s', async () => {
		const result = await withTimeout((await getView()).dataSource.fetch(main, 'httpauth', false, false), 30000, 'fetching from the remote requiring authentication (Git Graph\'s own Askpass prompt would wait for input)');
		assert(result !== null, 'The fetch unexpectedly succeeded');
		assert(fs.existsSync(fixtures.askpassLog), 'The external Askpass program was not invoked. Fetch result: ' + result);
		const prompts = fs.readFileSync(fixtures.askpassLog, 'utf8').trim().split('\n');
		assert(prompts.some((prompt) => prompt.startsWith('Username')), 'Unexpected Askpass prompts: ' + prompts.join(' | '));
		return 'External Askpass prompts: ' + prompts.join(' | ');
	});

	for (const [id, title, repo] of [
		['#789', 'The view refreshes when a commit is made in a submodule from outside of Visual Studio Code', sub],
		['#668-watch', 'The view refreshes when a commit is made in a worktree from outside of Visual Studio Code', wt]
	]) {
		await check(id, title, async () => {
			let since = marker(record);
			await vscode.commands.executeCommand('git-graph.view', { rootUri: vscode.Uri.file(repo) });
			await waitForCommitsLoaded(record, repo, since);
			await sleep(2500); // File events are muted for 1.5 seconds after the Git Graph View has run Git commands

			since = marker(record);
			git(repo, 'commit', '-q', '--allow-empty', '-m', 'Commit made outside of Visual Studio Code');
			const newHead = git(repo, 'rev-parse', 'HEAD');
			await waitFor('the extension to tell the Webview to refresh', () => record.responses.slice(since.responses).some((msg) => msg.command === 'refresh'), 15000);
			const response = await waitForCommitsLoaded(record, repo, since);
			assert(response.commits.some((commit) => commit.hash === newHead), 'The new commit was not loaded');
			return 'Refreshed, and loaded the new commit ' + newHead.substring(0, 8);
		});
	}

	// Webview UI checks: run ./webview-harness.js inside a copy of the Git Graph View's HTML, in a real Webview of this version of Visual Studio Code
	await (async () => {
		const start = Date.now();
		try {
			await getView();
			const html = await waitFor('the Webview HTML', () => record.html.slice().reverse().find((html) => html.includes('id="view"')));
			const nonce = html.match(/<script nonce="([^"]+)"/)[1];
			const harness = fs.readFileSync(path.join(__dirname, 'webview-harness.js'), 'utf8');
			const harnessHtml = html.replace(/<script nonce="[^"]+" src=/, (match) => '<script nonce="' + nonce + '">' + harness + '</script>' + match);

			const panel = vscode.window.createWebviewPanel('git-graph-e2e-harness', 'Git Graph (E2E UI Harness)', vscode.ViewColumn.One, {
				enableScripts: true,
				localResourceRoots: [vscode.Uri.file(path.join(extension.extensionPath, 'media'))]
			});
			const harnessResults = new Promise((resolve) => panel.webview.onDidReceiveMessage((msg) => {
				if (msg.command === 'e2eResults') resolve(msg.results);
			}));
			panel.webview.html = harnessHtml;
			const uiResults = await withTimeout(harnessResults, 90000, 'the Webview UI harness to report its results');
			uiResults.forEach((result) => results.push(Object.assign({}, result, { title: '[Webview UI] ' + result.title, durationMs: Date.now() - start })));
			panel.dispose();
		} catch (err) {
			results.push({ id: 'webview-harness', title: '[Webview UI] The Webview UI harness ran', pass: false, details: err && err.stack ? err.stack : String(err), durationMs: Date.now() - start });
		}
	})();

	const report = {
		date: new Date().toISOString(),
		vscodeVersion: vscode.version,
		gitVersion: fixtures.gitVersion,
		platform: process.platform + ' ' + process.arch,
		extensionHostNode: process.version,
		results: results
	};
	fs.writeFileSync(fixtures.report, JSON.stringify(report, null, '\t'));

	const failed = results.filter((result) => !result.pass);
	if (failed.length > 0) {
		throw new Error(failed.length + ' end-to-end check(s) failed: ' + failed.map((result) => result.id).join(', '));
	}
}

module.exports = { run };
