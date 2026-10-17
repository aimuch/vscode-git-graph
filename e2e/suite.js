/**
 * End-to-End Test Suite - Runs inside the Extension Host of a real instance of Visual Studio Code (see ./run.js).
 *
 * The checks drive Git Map the way a user does (running its commands, and the messages exchanged between the
 * Git Map View's Webview and the extension), against real Git repositories. Each check writes its result to the
 * report, so that the run can be verified & repeated.
 */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
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

// E2E_ONLY (a comma separated list of check ids, and / or "harness") only runs those checks, while developing them
const ONLY = process.env.E2E_ONLY ? process.env.E2E_ONLY.split(',') : null;

async function check(id, title, fn) {
	if (ONLY !== null && !ONLY.includes(id)) return;
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
 * Create a new repository for a check that changes it (outside of the workspace, so that it isn't discovered by Git Map).
 * @param name The name of the repository.
 * @param files The files committed in the first commit of the repository.
 * @returns The path of the repository.
 */
function createScratchRepo(name, files) {
	const repo = path.join(path.dirname(fixtures.workspace), 'scratch', name);
	fs.rmSync(repo, { recursive: true, force: true });
	fs.mkdirSync(repo, { recursive: true });
	git(repo, 'init', '-q', '-b', 'main');
	git(repo, 'config', 'commit.gpgsign', 'false');
	// The identity used by the Git commands that Git Map runs (the global Git config isn't used by the checks)
	git(repo, 'config', 'user.name', 'E2E Committer');
	git(repo, 'config', 'user.email', 'committer@example.com');
	Object.keys(files).forEach((file) => fs.writeFileSync(path.join(repo, file), files[file]));
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', 'Initial commit');
	return realpath(repo);
}

/**
 * Make a commit in a repository, changing a file.
 * @returns The hash of the commit.
 */
function commitFile(repo, file, contents, message) {
	fs.writeFileSync(path.join(repo, file), contents);
	git(repo, 'add', file);
	git(repo, 'commit', '-q', '-m', message);
	return git(repo, 'rev-parse', 'HEAD');
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

	await check('ui-commit-stats', '[Redesign] The files & lines changed by commits (merge commits compared to their first parent) and the uncommitted changes are loaded for the Changes column', async () => {
		const dataSource = (await getView()).dataSource;
		const result = await dataSource.getCommitStats(main, [fixtures.firstCommit, fixtures.secondAuthorCommit, fixtures.headCommit, '*']);
		assert(result.error === null, 'Loading the stats failed: ' + result.error);
		const stats = result.stats;
		assert(JSON.stringify(stats[fixtures.firstCommit]) === JSON.stringify({ files: 1, additions: 1, deletions: 0 }) && JSON.stringify(stats[fixtures.secondAuthorCommit]) === JSON.stringify({ files: 1, additions: 1, deletions: 1 }) && stats[fixtures.headCommit].files === 2 && stats['*'] === null, 'Unexpected stats: ' + JSON.stringify(stats));
		// A merge commit is compared to its first parent
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-map-e2e-merge-'));
		try {
			git(repo, 'init', '-q', '-b', 'main');
			fs.writeFileSync(path.join(repo, 'a.txt'), '1\n');
			git(repo, 'add', '-A');
			git(repo, 'commit', '-q', '-m', 'a');
			git(repo, 'checkout', '-q', '-b', 'feature');
			fs.writeFileSync(path.join(repo, 'b.txt'), '1\n2\n3\n');
			git(repo, 'add', '-A');
			git(repo, 'commit', '-q', '-m', 'b');
			git(repo, 'checkout', '-q', 'main');
			fs.writeFileSync(path.join(repo, 'a.txt'), '1\nx\n');
			git(repo, 'commit', '-q', '-a', '-m', 'c');
			git(repo, 'merge', '-q', '--no-edit', 'feature');
			const merge = git(repo, 'rev-parse', 'HEAD');
			const mergeStats = (await dataSource.getCommitStats(repo, [merge])).stats[merge];
			assert(JSON.stringify(mergeStats) === JSON.stringify({ files: 1, additions: 3, deletions: 0 }), 'Unexpected stats of the merge commit: ' + JSON.stringify(mergeStats));
			return JSON.stringify(stats[fixtures.secondAuthorCommit]) + ', merge: ' + JSON.stringify(mergeStats);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	await check('ui-stash-stats', '[Redesign] The stats of a stash (the files it changes, lines added & deleted, and untracked files it includes) are loaded for the list of stashes', async () => {
		const dataSource = (await getView()).dataSource;
		fs.writeFileSync(path.join(main, 'file.txt'), 'four\nfive\nsix\n');
		fs.writeFileSync(path.join(main, 'e2e-untracked.txt'), 'untracked\n');
		git(main, 'stash', 'push', '--include-untracked', '-m', 'E2E stash');
		try {
			const info = await dataSource.getRepoInfo(main, true, true, []);
			const stash = info.stashes.find((stash) => stash.message.includes('E2E stash'));
			assert(stash && stash.untrackedFilesHash !== null, 'The stash with untracked files is missing: ' + JSON.stringify(info.stashes));
			const result = await dataSource.getStashStats(main, [stash]);
			const stats = result.stats[stash.hash];
			assert(result.error === null && stats && stats.files === 2 && stats.additions === 2 && stats.deletions === 0 && stats.untrackedFiles === 1, 'Unexpected stats: ' + JSON.stringify(result));
			return stash.selector + ': ' + JSON.stringify(stats);
		} finally {
			git(main, 'stash', 'drop');
		}
	});

	await check('ui-file-history', '[Redesign] The history of a file follows it through renames, with the parents of its commits rewritten (so the graph is connected), the changes to the file in each commit, and its diff', async () => {
		const dataSource = (await getView()).dataSource;
		const commands = await vscode.commands.getCommands(true);
		assert(commands.includes('git-graph.viewFileHistory'), 'The View File History command isn\'t registered');
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-map-e2e-history-')); // Outside of the workspace, so it isn't discovered
		try {
			git(repo, 'init', '-q', '-b', 'main');
			fs.mkdirSync(path.join(repo, 'dir'));
			const commit = (message) => {
				git(repo, 'add', '-A');
				git(repo, 'commit', '-q', '-m', message);
				return git(repo, 'rev-parse', 'HEAD');
			};
			fs.writeFileSync(path.join(repo, 'dir', 'old.txt'), '1\n2\n3\n');
			const a = commit('a');
			fs.writeFileSync(path.join(repo, 'dir', 'old.txt'), '1\n2\n3\n4\n');
			const b = commit('b');
			fs.renameSync(path.join(repo, 'dir', 'old.txt'), path.join(repo, 'dir', '新.txt'));
			fs.writeFileSync(path.join(repo, 'dir', '新.txt'), '1\n2\n3\n4\n5\n');
			const c = commit('c (rename)');
			fs.writeFileSync(path.join(repo, 'other.txt'), 'x\n');
			commit('d (another file)');
			fs.writeFileSync(path.join(repo, 'dir', '新.txt'), '0\n1\n2\n3\n4\n5\n');
			const e = commit('e');

			const result = await dataSource.getCommits(repo, null, 100, true, true, false, false, 'date', [], [], [], null, 'dir/新.txt');
			assert(result.error === null, 'Loading the history failed: ' + result.error);
			const graph = result.commits.map((commit) => commit.hash + '>' + commit.parents.join(','));
			assert(JSON.stringify(graph) === JSON.stringify([e + '>' + c, c + '>' + b, b + '>' + a, a + '>']), 'Unexpected history: ' + JSON.stringify(result.commits.map((commit) => commit.message)));
			const history = result.fileHistory;
			assert(history !== null && JSON.stringify(history.paths) === JSON.stringify(['dir/新.txt', 'dir/old.txt']), 'Unexpected paths: ' + JSON.stringify(history && history.paths));
			assert(history.commits[c].oldFilePath === 'dir/old.txt' && history.commits[c].filePath === 'dir/新.txt' && history.commits[c].additions === 1 && history.commits[e].additions === 1 && history.commits[a].additions === 3 && history.commits[a].filePath === 'dir/old.txt', 'Unexpected changes: ' + JSON.stringify(history.commits));

			const diff = await dataSource.getFileDiff(repo, c, b, 'dir/old.txt', 'dir/新.txt');
			assert(diff.error === null && diff.diff.includes('rename from dir/old.txt') && /^\+5$/m.test(diff.diff), 'Unexpected diff: ' + diff.diff);
			const rootDiff = await dataSource.getFileDiff(repo, a, null, 'dir/old.txt', 'dir/old.txt');
			assert(rootDiff.error === null && /^\+1$/m.test(rootDiff.diff), 'Unexpected diff of the root commit: ' + rootDiff.diff);
			return result.commits.length + ' commits, renamed from dir/old.txt, diff of the rename: ' + diff.diff.split('\n').length + ' lines';
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	await check('ui-file-history-command', '[Redesign] The "View File History in Git Map" command opens the view showing the history of the file (relative to its repository)', async () => {
		const view = await getView();
		const since = { requests: record.requests.length, responses: record.responses.length };
		await vscode.commands.executeCommand('git-graph.viewFileHistory', vscode.Uri.file(path.join(main, 'file.txt')));
		const request = await waitFor('the history of file.txt to be requested', () => record.requests.slice(since.requests).find((msg) => msg.command === 'loadCommits' && msg.repo === main && msg.filePath === 'file.txt'));
		const response = await waitFor('the history to be loaded', () => record.responses.slice(since.responses).find((msg) => msg.command === 'loadCommits' && msg.refreshId === request.refreshId));
		const hashes = response.commits.map((commit) => commit.hash);
		assert(response.error === null && response.fileHistory !== null && hashes.length === 4 && hashes.includes(fixtures.firstCommit) && hashes.includes(fixtures.secondAuthorCommit) && !hashes.includes(fixtures.headCommit), 'Unexpected history of file.txt: ' + hashes.length + ' commits');
		// Exit the history of the file (so all commits are shown for the following checks)
		const exitSince = record.requests.length;
		view.respondLoadRepos(view.repoManager.getRepos(), { repo: main, fileHistory: null });
		await waitFor('all of the commits to be requested', () => record.requests.slice(exitSince).some((msg) => msg.command === 'loadCommits' && msg.repo === main && msg.filePath === null));
		return 'file.txt: ' + hashes.length + ' commits';
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

	await check('cherry-pick-commits', '[GitLens] Several selected commits are cherry picked together, oldest first (recording their origin if chosen)', async () => {
		const view = await getView(), dataSource = view.dataSource;
		const repo = createScratchRepo('cherry-pick', { 'base.txt': 'base\n' });
		git(repo, 'checkout', '-q', '-b', 'feature');
		const a = commitFile(repo, 'a.txt', 'a\n', 'Add a'), b = commitFile(repo, 'b.txt', 'b\n', 'Add b'), c = commitFile(repo, 'c.txt', 'c\n', 'Add c');
		git(repo, 'checkout', '-q', 'main');

		const error = await dataSource.cherrypickCommits(repo, [a, c], false, false);
		assert(error === null, 'Cherry picking failed: ' + error);
		const subjects = git(repo, 'log', '--format=%s', '-3').split('\n');
		assert(JSON.stringify(subjects) === JSON.stringify(['Add c', 'Add a', 'Initial commit']), 'Unexpected commits: ' + JSON.stringify(subjects));

		// The request from the Webview, recording the origin of each commit
		const count = record.responses.filter((msg) => msg.command === 'cherrypickCommits').length;
		await view.respondToMessage({ command: 'cherrypickCommits', repo: repo, commitHashes: [b], recordOrigin: true, noCommit: false });
		const response = await waitFor('the response', () => record.responses.filter((msg) => msg.command === 'cherrypickCommits')[count]);
		const body = git(repo, 'log', '-1', '--format=%B');
		assert(response.errors.every((error) => error === null) && body.includes('(cherry picked from commit ' + b + ')'), 'Unexpected result: ' + JSON.stringify(response) + ', ' + body);
		return 'main: ' + git(repo, 'log', '--format=%s', '-4').split('\n').join(' ← ');
	});

	// Undoing Git Map's actions. The ways it could go wrong, which these checks assert don't happen: losing uncommitted changes or
	// untracked files, undoing after the repository was changed by something else (or while a merge is in progress), restoring a
	// different commit / tag object than was there, losing a branch's upstream, and offering to undo after it was undone.
	const undoHelpers = (view, repo) => {
		// The response to a message (the view also loads the info of its repository itself, e.g. when it's refreshed after an action)
		const respond = async (msg, command, matches = () => true) => {
			const count = record.responses.filter((response) => response.command === command).length;
			await view.respondToMessage(msg);
			return waitFor('the ' + command + ' response', () => record.responses.filter((response) => response.command === command).slice(count).find(matches));
		};
		let refreshId = 1000;
		return {
			respond: respond,
			undoInfo: async () => {
				const id = ++refreshId;
				return (await respond({ command: 'loadRepoInfo', repo: repo, refreshId: id, showRemoteBranches: true, showStashes: true, hideRemotes: [] }, 'loadRepoInfo', (response) => response.refreshId === id)).undo;
			},
			undo: async () => (await respond({ command: 'undo', repo: repo }, 'undo')).error
		};
	};

	await check('undo-merge', '[GitKraken] A merge can be undone (keeping uncommitted changes & untracked files), unless the repository has changed since', async () => {
		const view = await getView();
		const repo = createScratchRepo('undo-merge', { 'a.txt': 'a\n' });
		const { respond, undoInfo, undo } = undoHelpers(view, repo);
		git(repo, 'checkout', '-q', '-b', 'feature');
		commitFile(repo, 'b.txt', 'b\n', 'Add b');
		git(repo, 'checkout', '-q', 'main');
		const beforeMerge = commitFile(repo, 'c.txt', 'c\n', 'Add c');
		fs.writeFileSync(path.join(repo, 'a.txt'), 'a (changed locally)\n');
		fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n');

		const merged = await respond({ command: 'merge', repo: repo, obj: 'feature', actionOn: 'Branch', createNewCommit: true, squash: false, noCommit: false }, 'merge');
		assert(merged.error === null && git(repo, 'rev-parse', 'HEAD') !== beforeMerge, 'The merge failed: ' + merged.error);
		const info = await undoInfo();
		assert(info && info.description === 'Merge "feature"', 'The merge can\'t be undone: ' + JSON.stringify(info));
		const error = await undo();
		assert(error === null, 'Undo failed: ' + error);
		assert(git(repo, 'rev-parse', 'HEAD') === beforeMerge && git(repo, 'symbolic-ref', '--short', 'HEAD') === 'main', 'HEAD wasn\'t restored: ' + git(repo, 'log', '--oneline', '-3'));
		assert(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === 'a (changed locally)\n' && fs.existsSync(path.join(repo, 'untracked.txt')), 'The uncommitted changes or untracked files were lost');
		assert(await undoInfo() === null, 'Undo is still offered after it was undone');

		// Undo is refused when the repository has been changed by something else since
		await respond({ command: 'merge', repo: repo, obj: 'feature', actionOn: 'Branch', createNewCommit: true, squash: false, noCommit: false }, 'merge');
		git(repo, 'commit', '-q', '--allow-empty', '-m', 'Committed outside of Git Map');
		const afterExternal = git(repo, 'rev-parse', 'HEAD');
		const refused = await undo();
		assert(refused !== null && refused.includes('has changed') && git(repo, 'rev-parse', 'HEAD') === afterExternal, 'Undo wasn\'t refused after an external commit: ' + refused);

		// Undo is refused while a merge is in progress (after an action that can be undone)
		git(repo, 'checkout', '-q', '-b', 'side', beforeMerge);
		const sideCommit = commitFile(repo, 'd.txt', 'd\n', 'Add d');
		commitFile(repo, 'c.txt', 'c (side)\n', 'Change c on side');
		git(repo, 'checkout', '-q', 'main');
		commitFile(repo, 'c.txt', 'c (main)\n', 'Change c on main');
		const picked = await respond({ command: 'cherrypickCommit', repo: repo, commitHash: sideCommit, parentIndex: 0, recordOrigin: false, noCommit: false }, 'cherrypickCommit');
		assert(picked.errors[0] === null && (await undoInfo()) !== null, 'The cherry pick can\'t be undone: ' + JSON.stringify(picked));
		try {
			git(repo, 'merge', 'side');
		} catch (_) { /* The merge conflicts */ }
		const inProgress = await undo();
		assert(inProgress !== null && inProgress.includes('in progress') && fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')), 'Undo wasn\'t refused while a merge is in progress: ' + inProgress);
		git(repo, 'merge', '--abort');
		return 'Undid the merge (local changes & untracked files kept); refused: "' + refused + '"; "' + inProgress + '"';
	});

	await check('undo-refs', '[GitKraken] Creating, deleting, checking out & renaming branches and tags can be undone (restoring the same commits, tag objects & upstreams)', async () => {
		const view = await getView();
		const repo = createScratchRepo('undo-refs', { 'a.txt': 'a\n' });
		const { respond, undoInfo, undo } = undoHelpers(view, repo);
		const first = git(repo, 'rev-parse', 'HEAD'), second = commitFile(repo, 'b.txt', 'b\n', 'Add b');
		const results = [];

		// Delete a branch (with an upstream)
		git(repo, 'branch', 'topic', first);
		git(repo, 'config', 'branch.topic.remote', 'origin');
		git(repo, 'config', 'branch.topic.merge', 'refs/heads/topic');
		await respond({ command: 'deleteBranch', repo: repo, branchName: 'topic', forceDelete: true, deleteOnRemotes: [] }, 'deleteBranch');
		assert((await undoInfo()).description === 'Delete Branch "topic"' && await undo() === null, 'Deleting the branch couldn\'t be undone');
		assert(git(repo, 'rev-parse', 'topic') === first && git(repo, 'config', 'branch.topic.merge') === 'refs/heads/topic', 'The branch or its upstream wasn\'t restored');
		results.push('deleted branch restored with its upstream');

		// Delete an annotated tag
		git(repo, 'tag', '-a', 'v1.0', '-m', 'Version 1.0', first);
		const tagObject = git(repo, 'rev-parse', 'refs/tags/v1.0');
		await respond({ command: 'deleteTag', repo: repo, tagName: 'v1.0', deleteOnRemote: null }, 'deleteTag');
		assert((await undoInfo()).description === 'Delete Tag "v1.0"' && await undo() === null, 'Deleting the tag couldn\'t be undone');
		assert(git(repo, 'rev-parse', 'refs/tags/v1.0') === tagObject && git(repo, 'cat-file', '-t', 'v1.0') === 'tag', 'A different tag object was restored');
		results.push('deleted annotated tag restored (same tag object)');

		// Add a tag
		await respond({ command: 'addTag', repo: repo, tagName: 'v2.0', commitHash: second, type: 'lightweight', message: '', pushToRemote: null, pushSkipRemoteCheck: false, force: false }, 'addTag');
		assert((await undoInfo()).description === 'Add Tag "v2.0"' && await undo() === null && git(repo, 'tag', '-l', 'v2.0') === '', 'Adding the tag couldn\'t be undone');
		results.push('added tag removed');

		// Create a branch & check it out
		await respond({ command: 'createBranch', repo: repo, branchName: 'new-branch', commitHash: first, checkout: true, force: false }, 'createBranch');
		assert(git(repo, 'symbolic-ref', '--short', 'HEAD') === 'new-branch', 'The branch wasn\'t checked out');
		assert((await undoInfo()).description === 'Create Branch "new-branch"' && await undo() === null, 'Creating the branch couldn\'t be undone');
		assert(git(repo, 'symbolic-ref', '--short', 'HEAD') === 'main' && git(repo, 'branch', '--list', 'new-branch') === '', 'The previous branch wasn\'t checked out, or the branch wasn\'t deleted');
		results.push('created & checked out branch removed');

		// Check out a branch
		await respond({ command: 'checkoutBranch', repo: repo, branchName: 'topic', remoteBranch: null, pullAfterwards: null }, 'checkoutBranch');
		assert((await undoInfo()).description === 'Checkout "topic"' && await undo() === null && git(repo, 'symbolic-ref', '--short', 'HEAD') === 'main', 'Checking out the branch couldn\'t be undone');
		results.push('checkout undone');

		// Rename a branch
		await respond({ command: 'renameBranch', repo: repo, oldName: 'topic', newName: 'renamed' }, 'renameBranch');
		assert((await undoInfo()).description === 'Rename Branch "topic"' && await undo() === null && git(repo, 'rev-parse', 'topic') === first && git(repo, 'branch', '--list', 'renamed') === '', 'Renaming the branch couldn\'t be undone');
		results.push('rename undone');
		return results.join('; ');
	});

	await check('undo-stash', '[GitKraken] Dropping a stash can be undone (the same stash is restored)', async () => {
		const view = await getView();
		const repo = createScratchRepo('undo-stash', { 'a.txt': 'a\n' });
		const { respond, undoInfo, undo } = undoHelpers(view, repo);
		fs.writeFileSync(path.join(repo, 'a.txt'), 'a (stashed)\n');
		git(repo, 'stash', 'push', '-q', '-m', 'Work in progress');
		const stash = git(repo, 'rev-parse', 'stash@{0}');
		await respond({ command: 'dropStash', repo: repo, selector: 'refs/stash@{0}' }, 'dropStash');
		assert(git(repo, 'stash', 'list') === '', 'The stash wasn\'t dropped');
		assert((await undoInfo()).description === 'Drop Stash "stash@{0}"' && await undo() === null, 'Dropping the stash couldn\'t be undone');
		assert(git(repo, 'rev-parse', 'stash@{0}') === stash && git(repo, 'stash', 'list').includes('Work in progress'), 'The stash wasn\'t restored: ' + git(repo, 'stash', 'list'));
		return 'Restored ' + git(repo, 'stash', 'list');
	});

	await check('worktrees', '[GitLens] The worktrees of a repository are listed, and can be added (for a branch, or at a commit), removed (only forced if they have changes) & pruned', async () => {
		const view = await getView();
		// The response to a message (the view also loads the worktrees of its repository itself, e.g. when it's refreshed after an action)
		const respond = async (msg, command, matches = () => true) => {
			const count = record.responses.filter((response) => response.command === command).length;
			await view.respondToMessage(msg);
			return waitFor('the ' + command + ' response', () => record.responses.filter((response) => response.command === command).slice(count).find(matches));
		};
		const list = async (repo) => {
			const response = await respond({ command: 'loadWorktrees', repo: repo }, 'loadWorktrees', (response) => response.repo === repo);
			assert(response.error === null, 'Loading the worktrees failed: ' + response.error);
			return response.worktrees;
		};

		// The worktrees of the main repository of the workspace
		const mainWorktrees = await list(main);
		assert(mainWorktrees.length === 2 && mainWorktrees[0].isMain && mainWorktrees[0].isCurrent && mainWorktrees[0].branch === 'main' && realpath(mainWorktrees[1].path) === wt && mainWorktrees[1].branch === 'wt-branch' && !mainWorktrees[1].isCurrent, 'Unexpected worktrees: ' + JSON.stringify(mainWorktrees));

		const repo = createScratchRepo('worktrees', { 'a.txt': 'a\n' }), first = git(repo, 'rev-parse', 'HEAD');
		const second = commitFile(repo, 'b.txt', 'b\n', 'Add b');
		const worktreePath = (name) => path.join(path.dirname(repo), 'worktrees-' + name).replace(/\\/g, '/');

		// A branch that's checked out (in the main worktree) can't be checked out in another worktree
		const checkedOut = await respond({ command: 'addWorktree', repo: repo, path: worktreePath('main'), ref: 'main', newBranch: null, open: false }, 'addWorktree');
		assert(checkedOut.errors[0] !== null && !fs.existsSync(worktreePath('main')), 'A checked out branch was added as a worktree');

		// A new branch, and a commit (detached HEAD)
		let added = await respond({ command: 'addWorktree', repo: repo, path: worktreePath('feature'), ref: 'main', newBranch: 'feature-wt', open: false }, 'addWorktree');
		assert(added.errors.length === 1 && added.errors[0] === null, 'Adding the worktree of a new branch failed: ' + JSON.stringify(added.errors));
		added = await respond({ command: 'addWorktree', repo: repo, path: worktreePath('detached'), ref: first, newBranch: null, open: false }, 'addWorktree');
		assert(added.errors[0] === null, 'Adding the worktree at a commit failed: ' + JSON.stringify(added.errors));
		let worktrees = await list(repo);
		const feature = worktrees.find((worktree) => worktree.branch === 'feature-wt'), detached = worktrees.find((worktree) => worktree.head === first);
		assert(worktrees.length === 3 && feature && feature.head === second && detached && detached.branch === null, 'Unexpected worktrees: ' + JSON.stringify(worktrees));

		// A worktree with uncommitted changes is only removed when forced
		fs.writeFileSync(path.join(worktreePath('feature'), 'a.txt'), 'a (changed)\n');
		const refused = await respond({ command: 'removeWorktree', repo: repo, path: worktreePath('feature'), force: false }, 'removeWorktree');
		assert(refused.error !== null && fs.existsSync(worktreePath('feature')), 'A worktree with uncommitted changes was removed without being forced');
		const forced = await respond({ command: 'removeWorktree', repo: repo, path: worktreePath('feature'), force: true }, 'removeWorktree');
		assert(forced.error === null && !fs.existsSync(worktreePath('feature')) && git(repo, 'rev-parse', 'feature-wt') === second, 'Forcing the removal failed (or the branch was removed): ' + forced.error);

		// A worktree whose directory was deleted is pruned
		fs.rmSync(worktreePath('detached'), { recursive: true, force: true });
		worktrees = await list(repo);
		assert(worktrees.length === 2 && worktrees[1].prunable, 'The deleted worktree isn\'t prunable: ' + JSON.stringify(worktrees));
		const pruned = await respond({ command: 'pruneWorktrees', repo: repo }, 'pruneWorktrees');
		worktrees = await list(repo);
		assert(pruned.error === null && worktrees.length === 1 && worktrees[0].isCurrent, 'The worktree wasn\'t pruned: ' + JSON.stringify(worktrees));
		return 'Workspace: ' + mainWorktrees.map((worktree) => worktree.branch).join(', ') + '; refused a checked out branch: "' + checkedOut.errors[0].trim().split('\n')[0] + '"; removal refused without force: "' + refused.error.trim().split('\n')[0] + '"; pruned';
	});

	await check('line-history', '[GitLens] The history of a range of lines only includes the commits that change them (following them as they move, and the file through renames), with the graph kept connected', async () => {
		const dataSource = (await getView()).dataSource;
		const lines = (changes) => Array.from({ length: 10 }, (_, i) => (changes[i + 1] || 'line ' + (i + 1)) + '\n').join('');
		const repo = createScratchRepo('line-history', { 'code.txt': lines({}) });
		const created = git(repo, 'rev-parse', 'HEAD');
		const changed3 = commitFile(repo, 'code.txt', lines({ 3: 'line 3 (changed)' }), 'Change line 3');
		const changed8 = commitFile(repo, 'code.txt', lines({ 3: 'line 3 (changed)', 8: 'line 8 (changed)' }), 'Change line 8');
		// Two lines are added above, so the line moves to line 5 (and the file is renamed)
		fs.writeFileSync(path.join(repo, 'code.txt'), 'new 1\nnew 2\n' + lines({ 3: 'line 3 (changed again)', 8: 'line 8 (changed)' }));
		git(repo, 'add', 'code.txt');
		git(repo, 'commit', '-q', '-m', 'Change line 3 again');
		const changedAgain = git(repo, 'rev-parse', 'HEAD');
		git(repo, 'mv', 'code.txt', 'renamed.txt');
		git(repo, 'commit', '-q', '-m', 'Rename the file');

		const data = await dataSource.getCommits(repo, null, 300, true, true, false, false, 'date', [], [], [], null, 'renamed.txt', { start: 5, end: 5 });
		assert(data.error === null, 'Loading the line history failed: ' + data.error);
		const hashes = data.commits.map((commit) => commit.hash), history = data.fileHistory;
		assert(JSON.stringify(hashes) === JSON.stringify([changedAgain, changed3, created]) && !hashes.includes(changed8), 'Unexpected commits: ' + data.commits.map((commit) => commit.message).join(', '));
		assert(JSON.stringify(data.commits.map((commit) => commit.parents)) === JSON.stringify([[changed3], [created], []]), 'The graph isn\'t connected: ' + JSON.stringify(data.commits.map((commit) => commit.parents)));
		assert(history.lineRange.start === 5 && history.commits[changed3].additions === 1 && history.commits[changed3].deletions === 1 && history.commits[changedAgain].additions === 1, 'Unexpected changes to the line: ' + JSON.stringify(history.commits));

		// The "View Line History in Git Map" command shows the history of the selected lines of the active editor
		const document = await vscode.workspace.openTextDocument(path.join(main, 'file.txt'));
		const editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(0, 0, 0, 2);
		const since = record.requests.length;
		await vscode.commands.executeCommand('git-graph.viewLineHistory');
		const request = await waitFor('the Webview to request the line history', () => record.requests.slice(since).find((msg) => msg.command === 'loadCommits' && msg.filePath === 'file.txt' && msg.lineRange))
			.catch((err) => { throw new Error(err.message + ' (requests: ' + record.requests.slice(since).map((msg) => msg.command + (msg.command === 'loadCommits' ? ' ' + msg.repo + ' ' + msg.filePath + ' ' + JSON.stringify(msg.lineRange) : '')).join(', ') + '; HTML loadViewTo: ' + (record.html.length > 0 ? (record.html[record.html.length - 1].match(/"loadViewTo":(\{[^}]*\}[^,]*)/) || [])[1] : '') + ')'); });
		assert(request.repo === main && request.lineRange.start === 1 && request.lineRange.end === 1, 'Unexpected request: ' + JSON.stringify(request));
		const response = await waitFor('the line history', () => record.responses.find((msg) => msg.command === 'loadCommits' && msg.refreshId === request.refreshId));
		const shown = response.commits.map((commit) => commit.hash);
		assert(shown.includes(fixtures.firstCommit) && shown.includes(fixtures.secondAuthorCommit) && !shown.includes(fixtures.headCommit), 'Unexpected line history: ' + response.commits.map((commit) => commit.message).join(', '));
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		return 'Line 5 of renamed.txt: ' + data.commits.map((commit) => commit.message).join(' ← ') + '; command: line 1 of file.txt (' + shown.length + ' commits)';
	});

	await check('line-blame', '[GitLens] The line the cursor is on is blamed using the contents of the editor (so lines of files with uncommitted changes match), and the blame links to the commit in Git Map', async () => {
		const view = await getView(), dataSource = view.dataSource;
		const repo = createScratchRepo('line-blame', { 'code.txt': 'one\ntwo\nthree\n' });
		const changedTwo = commitFile(repo, 'code.txt', 'one\ntwo (changed)\nthree\n', 'Change line two');
		// Uncommitted changes add a line above the blamed line
		const contents = 'zero (uncommitted)\none\ntwo (changed)\nthree\n';
		const blame = await dataSource.getLineBlame(repo, 'code.txt', 3, contents), uncommitted = await dataSource.getLineBlame(repo, 'code.txt', 1, contents);
		assert(blame !== null && blame.hash === changedTwo && blame.committed && blame.summary === 'Change line two' && blame.author === 'E2E Author' && blame.authorEmail === 'author@example.com', 'Unexpected blame: ' + JSON.stringify(blame));
		assert(uncommitted !== null && !uncommitted.committed, 'The uncommitted line wasn\'t recognised: ' + JSON.stringify(uncommitted));
		const { getBlameText } = require(path.join(extension.extensionPath, 'out', 'lineBlame.js'));
		const text = getBlameText(blame);
		assert(/^E2E Author, \d+ seconds? ago • Change line two$/.test(text) && getBlameText(uncommitted) === 'You, Uncommitted changes', 'Unexpected text: ' + text);
		assert(await dataSource.getLineBlame(repo, 'untracked.txt', 1, 'x\n') === null, 'An untracked file was blamed');

		// The link opens the commit in the Git Map View (as soon as the view, which was just shown again, has loaded)
		const since = record.requests.length;
		await vscode.commands.executeCommand('git-graph.viewCommitInGitMap', main, fixtures.firstCommit);
		const details = await waitFor('the details of the commit to be requested', () => record.requests.slice(since).find((msg) => msg.command === 'commitDetails' && msg.commitHash === fixtures.firstCommit))
			.catch((err) => { throw new Error(err.message + ' (requests: ' + record.requests.slice(since).map((msg) => msg.command + (msg.repo ? ' ' + msg.repo : '')).join(', ') + ')'); });
		return 'Blame: ' + text + '; the link requested the details of ' + details.commitHash.substring(0, 8);
	});

	await check('rebase-editor', '[GitLens] An interactive rebase runs the todo list chosen in the Rebase Editor (pick, reword, squash, fixup, drop & reorder) without opening an editor or running names / messages in a shell, and a rebase that stops can be continued or aborted', async () => {
		const view = await getView(), dataSource = view.dataSource;
		const repo = createScratchRepo('rebase-editor', { 'base.txt': 'base\n' }), base = git(repo, 'rev-parse', 'HEAD');
		const injection = 'pwn$(>rebase-injection-marker)', marker = path.join(repo, 'rebase-injection-marker');
		git(repo, 'branch', injection, base);
		git(repo, 'checkout', '-q', '-b', 'feature');
		const a = commitFile(repo, 'a.txt', 'a\n', 'Add a'), b = commitFile(repo, 'b.txt', 'b\n', 'Add b');
		const c = commitFile(repo, 'c.txt', 'c\n', 'Add c'), d = commitFile(repo, 'd.txt', 'd\n', 'Add d');
		const original = git(repo, 'rev-parse', 'HEAD');

		// The commits that are rebased (oldest first)
		const listed = await dataSource.getRebaseCommits(repo, injection);
		assert(listed.error === null && JSON.stringify(listed.commits.map((commit) => commit.hash)) === JSON.stringify([a, b, c, d]) && listed.commits[1].subject === 'Add b' && listed.commits[1].author === 'E2E Author', 'Unexpected commits: ' + JSON.stringify(listed));

		// Reorder, reword (with a message containing shell syntax), squash & drop
		const message = 'B reworded $(>rebase-message-marker)\n\nWith a body';
		const error = await dataSource.rebaseInteractive(repo, injection, [
			{ action: 'pick', hash: b, message: null },
			{ action: 'reword', hash: a, message: message },
			{ action: 'squash', hash: c, message: null },
			{ action: 'drop', hash: d, message: null }
		]);
		assert(error === null, 'The rebase failed: ' + error);
		const subjects = git(repo, 'log', '--format=%s', base + '..HEAD').split('\n');
		assert(JSON.stringify(subjects) === JSON.stringify(['B reworded $(>rebase-message-marker)', 'Add b']), 'Unexpected commits: ' + JSON.stringify(subjects));
		const squashed = git(repo, 'log', '-1', '--format=%B');
		assert(squashed.startsWith(message) && squashed.includes('Add c') && !squashed.includes('#'), 'Unexpected message of the squashed commit: ' + JSON.stringify(squashed));
		assert(fs.existsSync(path.join(repo, 'c.txt')) && !fs.existsSync(path.join(repo, 'd.txt')), 'The squashed / dropped commits are wrong');
		assert(!fs.existsSync(marker) && !fs.existsSync(path.join(repo, 'rebase-message-marker')), 'The branch name or message was run by the shell');
		assert(await dataSource.getOperationInProgress(repo) === null, 'The rebase is still in progress');

		// A rebase that stops because of a conflict can be aborted (and continued)
		git(repo, 'reset', '-q', '--hard', original);
		git(repo, 'checkout', '-q', '-b', 'conflicting', base);
		const conflicting = commitFile(repo, 'a.txt', 'a (conflict)\n', 'Conflicting a');
		git(repo, 'checkout', '-q', 'feature');
		const stopped = await dataSource.rebaseInteractive(repo, conflicting, [{ action: 'pick', hash: a, message: null }, { action: 'pick', hash: b, message: null }]);
		assert(stopped !== null && await dataSource.getOperationInProgress(repo) === 'rebase', 'The rebase didn\'t stop at the conflict: ' + stopped);
		const response = await (async () => {
			const count = record.responses.filter((msg) => msg.command === 'loadOperationInProgress').length;
			await view.respondToMessage({ command: 'loadOperationInProgress', repo: repo });
			return waitFor('the operation in progress', () => record.responses.filter((msg) => msg.command === 'loadOperationInProgress').slice(count).find((msg) => msg.repo === repo));
		})();
		assert(response.operation === 'rebase', 'Unexpected operation: ' + JSON.stringify(response));
		const aborted = await dataSource.controlOperation(repo, 'rebase', 'abort');
		assert(aborted === null && git(repo, 'rev-parse', 'HEAD') === original && await dataSource.getOperationInProgress(repo) === null, 'Aborting the rebase failed: ' + aborted);
		await dataSource.rebaseInteractive(repo, conflicting, [{ action: 'pick', hash: a, message: null }]);
		fs.writeFileSync(path.join(repo, 'a.txt'), 'a (resolved)\n');
		git(repo, 'add', 'a.txt');
		const continued = await dataSource.controlOperation(repo, 'rebase', 'continue');
		assert(continued === null && await dataSource.getOperationInProgress(repo) === null && git(repo, 'log', '-1', '--format=%s') === 'Add a', 'Continuing the rebase failed: ' + continued);
		return 'Rebased: ' + subjects.join(' ← ') + '; stopped at a conflict: aborted, then continued after resolving it';
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
		if (ONLY !== null && !ONLY.includes('harness')) return;
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
			// The settings that freeze the column headers & footer are booleans (a string isn't accepted)
			const freeze = await send('graph.freezeFooter', false);
			const freezeString = await send('graph.freezeColumnHeaders', 'false');
			const config = vscode.workspace.getConfiguration('git-graph');
			assert(freeze.error === null && config.inspect('graph.freezeFooter').globalValue === false && freezeString.error !== null && config.inspect('graph.freezeColumnHeaders').globalValue === undefined, 'Unexpected boolean settings: ' + freeze.error + ' / ' + freezeString.error);
			return 'Valid: updated; invalid value: "' + invalidValue.error + '"; other setting: "' + invalidKey.error + '"; boolean: updated, as a string: "' + freezeString.error + '"';
		} finally {
			await vscode.workspace.getConfiguration('git-graph').update('statusBarItemDisplay', undefined, vscode.ConfigurationTarget.Global);
			// Changing the setting re-renders the open view, which must happen before the next check waits for the view to be re-rendered
			const renders = record.html.length;
			await vscode.workspace.getConfiguration('git-graph').update('graph.freezeFooter', undefined, vscode.ConfigurationTarget.Global);
			await waitFor('the view to be re-rendered', () => record.html.length > renders, 5000).catch(() => null);
			await new Promise((resolve) => setTimeout(resolve, 500));
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
		assert(html.includes('data-label="Repo"') && html.includes('"l10n":null'), 'The view wasn\'t re-rendered in English');
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
