/**
 * End-to-End Test Suite - Runs inside the Extension Host of a real instance of Visual Studio Code (see ./run.js).
 *
 * The checks drive Git Map the way a user does (running its commands, and the messages exchanged between the
 * Git Map View's Webview and the extension), against real Git repositories. Each check writes its result to the
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
 * Instrument the Git Map View, recording the messages exchanged between its Webview and the extension.
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
	return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.label === 'Git Map');
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
	const extension = vscode.extensions.getExtension('aimdev.git-map');
	assert(extension, 'The Git Map extension is not loaded');
	const { GitGraphView, record } = instrumentGitGraphView(extension.extensionPath);
	await extension.activate();

	const main = realpath(fixtures.main), sub = realpath(fixtures.sub), wt = realpath(fixtures.wt);

	// Get the open Git Map View (opening it if a previous check failed to), so that each check is independent of the others
	const getView = async () => {
		if (!GitGraphView.currentPanel) await vscode.commands.executeCommand('git-graph.view');
		return waitFor('the Git Map View to open', () => GitGraphView.currentPanel);
	};

	await check('activation', 'Git Map activates in this version of Visual Studio Code (onStartupFinished)', async () => {
		const packageJson = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, 'package.json'), 'utf8'));
		assert(extension.isActive, 'The extension is not active');
		assert(JSON.stringify(packageJson.activationEvents) === '["onStartupFinished"]', 'Unexpected activation events: ' + JSON.stringify(packageJson.activationEvents));
		return 'Visual Studio Code ' + vscode.version + ', engines.vscode ' + packageJson.engines.vscode;
	});

	await check('#903', '"View Git Map" is contributed to the scm/repository menu (Source Control Repositories view)', async () => {
		const menus = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, 'package.json'), 'utf8')).contributes.menus;
		const repositoryMenu = menus['scm/repository'] || [];
		assert(repositoryMenu.some((item) => item.command === 'git-graph.view' && item.group === 'inline' && item.when.includes('\'Inline\'')), 'No inline scm/repository menu item');
		assert(repositoryMenu.some((item) => item.command === 'git-graph.view' && item.group !== 'inline' && item.when.includes('\'More Actions\'')), 'No "More Actions" scm/repository menu item');
	});

	await check('status-bar', 'The Status Bar Item displays the Git Map icon and / or text, as configured by git-graph.statusBarItemDisplay', async () => {
		const packageJson = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, 'package.json'), 'utf8'));
		const icon = packageJson.contributes.icons['git-graph-logo'];
		assert(icon && fs.statSync(path.join(extension.extensionPath, icon.default.fontPath)).size > 0, 'The git-graph-logo icon font is missing');

		const { StatusBarItem } = require(path.join(extension.extensionPath, 'out', 'statusBarItem.js'));
		const { EventEmitter } = require(path.join(extension.extensionPath, 'out', 'utils', 'event.js'));
		const { Logger } = require(path.join(extension.extensionPath, 'out', 'logger.js'));
		const onDidChangeRepos = new EventEmitter(), onDidChangeConfiguration = new EventEmitter(), logger = new Logger();
		const statusBarItem = new StatusBarItem(1, onDidChangeRepos.subscribe, onDidChangeConfiguration.subscribe, logger);
		const texts = {};
		try {
			for (const display of ['Icon', 'Text', 'Icon & Text']) {
				await vscode.workspace.getConfiguration('git-graph').update('statusBarItemDisplay', display, vscode.ConfigurationTarget.Global);
				onDidChangeConfiguration.emit({ affectsConfiguration: (section) => section === 'git-graph' || section === 'git-graph.statusBarItemDisplay' });
				texts[display] = statusBarItem.statusBarItem.text;
			}
		} finally {
			await vscode.workspace.getConfiguration('git-graph').update('statusBarItemDisplay', undefined, vscode.ConfigurationTarget.Global);
			statusBarItem.dispose();
			logger.dispose();
		}
		assert(texts['Icon'] === '$(git-graph-logo)' && texts['Text'] === 'Git Map' && texts['Icon & Text'] === '$(git-graph-logo) Git Map', 'Unexpected texts: ' + JSON.stringify(texts));
		return JSON.stringify(texts);
	});

	await check('#794', 'The "View Git Map" command opens the view when invoked with a null argument', async () => {
		const since = marker(record);
		await vscode.commands.executeCommand('git-graph.view', null);
		await waitFor('the Git Map View to open', () => GitGraphView.currentPanel && getGitGraphTabs().length === 1, 10000);
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

	await check('ui-file-icon-theme', '[Redesign] The file icon theme of Visual Studio Code (Seti) is sent to the Webview, with its language ids mapped to file extensions and its font loadable by the Webview', async () => {
		const view = await getView();
		const count = record.responses.filter((msg) => msg.command === 'loadFileIconTheme').length;
		await view.respondToMessage({ command: 'loadFileIconTheme' });
		const response = await waitFor('the file icon theme', () => {
			const responses = record.responses.filter((msg) => msg.command === 'loadFileIconTheme');
			return responses.length > count ? responses[responses.length - 1] : null;
		});
		const theme = response.theme, iconTheme = vscode.workspace.getConfiguration('workbench').get('iconTheme');
		assert(theme !== null && theme.id === iconTheme, 'Unexpected file icon theme: ' + (theme && theme.id) + ' (workbench.iconTheme: ' + iconTheme + ')');
		const tsIcon = theme.definitions[theme.fileExtensions['ts']];
		assert(tsIcon && typeof tsIcon.fontCharacter === 'string' && tsIcon.fontCharacter.length === 1 && tsIcon.fontColor !== null, 'TypeScript files don\'t have a font icon: ' + JSON.stringify(tsIcon));
		assert(theme.fonts.length > 0 && !theme.fonts[0].src.startsWith('file:') && theme.fonts[0].src.includes('seti'), 'The font isn\'t loadable by the Webview: ' + (theme.fonts[0] && theme.fonts[0].src));
		const html = record.html.slice().reverse().find((html) => html.includes('id="view"'));
		assert(/font-src [^;"]+/.test(html), 'The CSP doesn\'t allow the font to be loaded');
		return theme.id + ': ' + Object.keys(theme.definitions).length + ' icons, .ts → ' + theme.fileExtensions['ts'] + ', font ' + theme.fonts[0].id;
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

	await check('#171', 'Commits can be filtered by author (a name containing regular expression characters is matched literally)', async () => {
		const dataSource = (await getView()).dataSource;
		const getHashes = async (authors) => {
			const result = await dataSource.getCommits(main, null, 300, true, true, false, false, 'date', ['origin'], [], [], authors);
			assert(result.error === null, 'Loading the commits failed: ' + result.error);
			return result.commits.filter((commit) => commit.hash !== '*').map((commit) => commit.hash);
		};
		const all = await getHashes(null);
		const secondAuthor = await getHashes([fixtures.secondAuthor]);
		assert(secondAuthor.length === 1 && secondAuthor[0] === fixtures.secondAuthorCommit, 'Unexpected commits for "' + fixtures.secondAuthor + '": ' + JSON.stringify(secondAuthor));
		const regexLike = await getHashes(['Dr. Q.A (Second)']); // "." must not match the "+" in the author's name
		assert(regexLike.length === 0, 'The author name was matched as a regular expression: ' + JSON.stringify(regexLike));
		const bothAuthors = await getHashes(['E2E Author', fixtures.secondAuthor]);
		assert(bothAuthors.length === all.length, 'Selecting all authors returned ' + bothAuthors.length + ' of ' + all.length + ' commits');
		return 'All authors: ' + all.length + ' commits, "' + fixtures.secondAuthor + '": 1 commit';
	});

	await check('ui-sync-search', '[Redesign] The repository info includes how far each branch is behind / ahead of its upstream, and commits can be searched by the files they change (file:) and the lines they add or remove (change:)', async () => {
		const dataSource = (await getView()).dataSource;
		git(main, 'branch', 'e2e-behind', fixtures.crCommit);
		git(main, 'branch', '--set-upstream-to=origin/main', 'e2e-behind');
		git(main, 'branch', 'e2e-gone', fixtures.firstCommit);
		git(main, 'config', 'branch.e2e-gone.remote', 'origin');
		git(main, 'config', 'branch.e2e-gone.merge', 'refs/heads/e2e-deleted');
		try {
			const info = await dataSource.getRepoInfo(main, true, false, []);
			assert(info.error === null, 'Loading the repository info failed: ' + info.error);
			const behind = info.upstreams['e2e-behind'], gone = info.upstreams['e2e-gone'];
			assert(behind && behind.name === 'origin/main' && behind.behind === 3 && behind.ahead === 0 && !behind.gone, 'Unexpected upstream of e2e-behind: ' + JSON.stringify(behind));
			assert(gone && gone.name === 'origin/e2e-deleted' && gone.gone, 'Unexpected upstream of e2e-gone: ' + JSON.stringify(gone));
			assert(typeof info.upstreams['main'] === 'undefined', 'main shouldn\'t have an upstream: ' + JSON.stringify(info.upstreams['main']));

			const search = async (files, changes, isRegex, isCaseSensitive) => {
				const result = await dataSource.searchCommits(main, files, changes, isRegex, isCaseSensitive, 0);
				assert(result.error === null, 'Searching failed: ' + result.error);
				return result.hashes;
			};
			const fileMatches = await search(['FILE.TXT'], [], false, false);
			assert(fileMatches.length === 4 && fileMatches.includes(fixtures.firstCommit) && fileMatches.includes(fixtures.secondAuthorCommit) && !fileMatches.includes(fixtures.headCommit), 'Unexpected commits changing FILE.TXT: ' + fileMatches.length);
			assert((await search(['FILE.TXT'], [], false, true)).length === 0, 'The case sensitive file search matched file.txt');
			const changeMatches = await search([], ['FOUR'], false, false);
			assert(changeMatches.length === 1 && changeMatches[0] === fixtures.secondAuthorCommit, 'Unexpected commits changing a line containing FOUR: ' + JSON.stringify(changeMatches));
			const literal = await search([], ['t.o'], false, true), regex = await search([], ['t.o'], true, true);
			assert(literal.length === 0 && regex.length === 2 && regex.includes(fixtures.crCommit), 'Unexpected commits changing t.o: ' + literal.length + ' (literal), ' + regex.length + ' (regular expression)');
			const both = await search(['file'], ['four', 'one'], false, false);
			assert(both.length === 0, 'A commit was matched by only one of the changes: ' + JSON.stringify(both));
			return 'e2e-behind: ' + behind.behind + ' behind ' + behind.name + ', e2e-gone: gone; file: ' + fileMatches.length + ' commits, change: ' + changeMatches.length + ' commit, t.o: ' + literal.length + ' literal / ' + regex.length + ' regex';
		} finally {
			git(main, 'branch', '-D', 'e2e-behind', 'e2e-gone');
		}
	});

	await check('#940', 'Interactive rebase on a branch whose name contains shell syntax does not execute it', async () => {
		const dataSource = (await getView()).dataSource;
		assert(!fs.existsSync(fixtures.injectionMarker), 'The marker exists before the rebase');
		const reflogBefore = git(main, 'reflog', '--format=%gs').split('\n').length;
		const error = await dataSource.rebase(main, fixtures.injectionBranch, 'Branch', false, true);
		assert(error === null, 'Rebase returned an error: ' + error);
		const terminal = vscode.window.terminals.find((terminal) => terminal.name === 'Git Map: Rebase on "' + fixtures.injectionBranch + '"');
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

	await check('#932', 'An externally configured GIT_ASKPASS is used for authentication instead of Git Map\'s', async () => {
		const result = await withTimeout((await getView()).dataSource.fetch(main, 'httpauth', false, false), 30000, 'fetching from the remote requiring authentication (Git Map\'s own Askpass prompt would wait for input)');
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
			await sleep(2500); // File events are muted for 1.5 seconds after the Git Map View has run Git commands

			since = marker(record);
			git(repo, 'commit', '-q', '--allow-empty', '-m', 'Commit made outside of Visual Studio Code');
			const newHead = git(repo, 'rev-parse', 'HEAD');
			await waitFor('the extension to tell the Webview to refresh', () => record.responses.slice(since.responses).some((msg) => msg.command === 'refresh'), 15000);
			const response = await waitForCommitsLoaded(record, repo, since);
			assert(response.commits.some((commit) => commit.hash === newHead), 'The new commit was not loaded');
			return 'Refreshed, and loaded the new commit ' + newHead.substring(0, 8);
		});
	}

	await check('#775', 'Selecting a graph colour preset re-renders the open Git Map View with the preset\'s colours', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert(commands.includes('git-graph.selectGraphColourPreset'), 'The "Select Graph Colour Preset" command is not registered');
		await vscode.commands.executeCommand('git-graph.view', { rootUri: vscode.Uri.file(main) });
		await waitFor('the Git Map View to be visible', () => GitGraphView.currentPanel && GitGraphView.currentPanel.panel.visible);
		const colourOf = (html) => (html.match(/--git-graph-color0:([^;]+);/) || [])[1];
		try {
			const renders = record.html.length;
			await vscode.workspace.getConfiguration('git-graph').update('graph.colourPreset', 'Tokyo Subway', vscode.ConfigurationTarget.Global);
			const html = await waitFor('the view to be re-rendered', () => record.html.slice(renders).find((html) => html.includes('id="view"')));
			assert(colourOf(html) === '#f62e36', 'Unexpected first graph colour: ' + colourOf(html));
		} finally {
			const renders = record.html.length;
			await vscode.workspace.getConfiguration('git-graph').update('graph.colourPreset', undefined, vscode.ConfigurationTarget.Global);
			await waitFor('the view to be re-rendered with the default colours', () => record.html.slice(renders).some((html) => colourOf(html) === '#0085d9'));
		}
		return 'Tokyo Subway → --git-graph-color0: #f62e36, Default → #0085d9';
	});

	// Webview UI checks: run ./webview-harness.js inside a copy of the Git Map View's HTML, in a real Webview of this version of Visual Studio Code
	const runWebviewHarness = async (html, titlePrefix) => {
		const start = Date.now();
		try {
			const nonce = html.match(/<script nonce="([^"]+)"/)[1];
			const harness = fs.readFileSync(path.join(__dirname, 'webview-harness.js'), 'utf8');
			const harnessHtml = html.replace(/<script nonce="[^"]+" src=/, (match) => '<script nonce="' + nonce + '">' + harness + '</script>' + match);

			const panel = vscode.window.createWebviewPanel('git-graph-e2e-harness', 'Git Map (E2E UI Harness)', vscode.ViewColumn.One, {
				enableScripts: true,
				localResourceRoots: [vscode.Uri.file(path.join(extension.extensionPath, 'media'))]
			});
			const harnessResults = new Promise((resolve) => panel.webview.onDidReceiveMessage((msg) => {
				if (msg.command === 'e2eResults') resolve(msg.results);
			}));
			panel.webview.html = harnessHtml;
			const uiResults = await withTimeout(harnessResults, 90000, 'the Webview UI harness to report its results');
			uiResults.forEach((result) => results.push(Object.assign({}, result, { title: titlePrefix + result.title, durationMs: Date.now() - start })));
			panel.dispose();
		} catch (err) {
			results.push({ id: 'webview-harness', title: titlePrefix + 'The Webview UI harness ran', pass: false, details: err && err.stack ? err.stack : String(err), durationMs: Date.now() - start });
		}
	};
	await getView();
	await runWebviewHarness(await waitFor('the Webview HTML', () => record.html.slice().reverse().find((html) => html.includes('id="view"'))), '[Webview UI] ');

	// Display the Git Map View, Status Bar Item & Webview UI in Simplified Chinese (git-graph.language), as a user who has set it would see them
	let chineseHtml = null;
	await check('ui-settings-update', '[Redesign] The Repository Settings panel can only update its whitelisted Extension Settings, for all repositories', async () => {
		const view = await getView();
		const responses = () => record.responses.filter((msg) => msg.command === 'updateExtensionSetting');
		const send = async (key, value) => {
			const count = responses().length;
			await view.respondToMessage({ command: 'updateExtensionSetting', key: key, value: value });
			return waitFor('the response', () => responses().length > count ? responses()[responses().length - 1] : null);
		};
		try {
			const valid = await send('statusBarItemDisplay', 'Text');
			assert(valid.error === null && vscode.workspace.getConfiguration('git-graph').inspect('statusBarItemDisplay').globalValue === 'Text', 'The valid setting wasn\'t updated: ' + valid.error);
			const invalidValue = await send('statusBarItemDisplay', 'Huge');
			const invalidKey = await send('repository.commits.initialLoad', '1');
			assert(invalidValue.error !== null && invalidKey.error !== null && vscode.workspace.getConfiguration('git-graph').inspect('repository.commits.initialLoad').globalValue === undefined, 'An invalid setting was updated');
			return 'Valid: updated; invalid value: "' + invalidValue.error + '"; other setting: "' + invalidKey.error + '"';
		} finally {
			await vscode.workspace.getConfiguration('git-graph').update('statusBarItemDisplay', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	await check('l10n', 'Setting git-graph.language to Simplified Chinese re-renders the open Git Map View & Status Bar Item in Simplified Chinese', async () => {
		const packageJson = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, 'package.json'), 'utf8'));
		const nlsKeys = (file) => Object.keys(JSON.parse(fs.readFileSync(path.join(extension.extensionPath, file), 'utf8')));
		const placeholders = Array.from(new Set(JSON.stringify(packageJson.contributes).match(/"%[^"%]+%"/g).map((key) => key.slice(2, -2))));
		const missingNls = ['package.nls.json', 'package.nls.zh-cn.json'].flatMap((file) => placeholders.filter((key) => !nlsKeys(file).includes(key)).map((key) => file + ': ' + key));
		assert(missingNls.length === 0, 'The contributions are missing descriptions: ' + missingNls.join(', '));

		const { StatusBarItem } = require(path.join(extension.extensionPath, 'out', 'statusBarItem.js'));
		const { EventEmitter } = require(path.join(extension.extensionPath, 'out', 'utils', 'event.js'));
		const { Logger } = require(path.join(extension.extensionPath, 'out', 'logger.js'));
		const onDidChangeRepos = new EventEmitter(), onDidChangeConfiguration = new EventEmitter(), logger = new Logger();
		const statusBarItem = new StatusBarItem(1, onDidChangeRepos.subscribe, onDidChangeConfiguration.subscribe, logger);
		await vscode.commands.executeCommand('git-graph.view', { rootUri: vscode.Uri.file(main) });
		await waitFor('the Git Map View to be visible', () => GitGraphView.currentPanel && GitGraphView.currentPanel.panel.visible);
		try {
			const tooltipBefore = statusBarItem.statusBarItem.tooltip;
			const renders = record.html.length;
			await vscode.workspace.getConfiguration('git-graph').update('language', 'Simplified Chinese', vscode.ConfigurationTarget.Global);
			onDidChangeConfiguration.emit({ affectsConfiguration: (section) => section === 'git-graph' || section === 'git-graph.language' });
			chineseHtml = await waitFor('the view to be re-rendered', () => record.html.slice(renders).find((html) => html.includes('id="view"')));
			assert(tooltipBefore === 'View Git Map' && statusBarItem.statusBarItem.tooltip === '查看 Git Map', 'Unexpected Status Bar Item tooltips: ' + tooltipBefore + ' → ' + statusBarItem.statusBarItem.tooltip);
			assert(chineseHtml.includes('<html lang="zh-CN">'), 'The view isn\'t marked as Simplified Chinese');
			assert(chineseHtml.includes('仓库：') && chineseHtml.includes('"l10n":{'), 'The view wasn\'t rendered with the Simplified Chinese translations');
			return placeholders.length + ' contribution descriptions in package.nls.json & package.nls.zh-cn.json, Status Bar Item tooltip: ' + tooltipBefore + ' → ' + statusBarItem.statusBarItem.tooltip;
		} finally {
			statusBarItem.dispose();
			logger.dispose();
		}
	});
	if (chineseHtml !== null) {
		await runWebviewHarness(chineseHtml, '[Webview UI, 简体中文] ');
	}
	await check('l10n-reset', 'Resetting git-graph.language re-renders the open Git Map View in the display language of Visual Studio Code (English)', async () => {
		await getView();
		const renders = record.html.length;
		await vscode.workspace.getConfiguration('git-graph').update('language', undefined, vscode.ConfigurationTarget.Global);
		// The view can also be re-rendered (in the previous language) when it becomes visible again after the harness' Webview is closed
		const html = await waitFor('the view to be re-rendered in English', () => record.html.slice(renders).find((html) => html.includes('<html lang="en">'))).catch((err) => {
			throw new Error(err.message + '. Rendered: ' + record.html.slice(renders).map((html) => (html.match(/<html lang="([^"]+)">/) || [])[1]).join(', '));
		});
		assert(html.includes('Repo:') && html.includes('"l10n":null'), 'The view wasn\'t re-rendered in English');
		return 'vscode.env.language: ' + vscode.env.language;
	});

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
