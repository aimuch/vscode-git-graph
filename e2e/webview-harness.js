/**
 * Webview UI Harness - Injected (by ./suite.js) into a copy of the Git Map View's HTML, and run in a real Visual
 * Studio Code Webview. It replaces the Webview's messaging API with a fake back-end serving fixture data, drives the
 * UI with DOM events (as a user would), and posts the result of each check back to the Extension Host.
 */
(function () {
	'use strict';
	const realApi = acquireVsCodeApi();
	const requests = [];
	const REPO = '/e2e/harness-repo';
	const NOW = Math.round(Date.now() / 1000);
	const ISSUE_URL = 'gitgraph-e2e://issue/$1';
	const hash = (n) => n.toString(16).padStart(40, '0');
	const HEAD_INDEX = 19;
	// Stashes that aren't in the loaded commits (so the commits are the same as without stashes)
	const STASHES = [
		{ hash: 'a'.repeat(40), baseHash: 'f'.repeat(40), untrackedFilesHash: null, selector: 'refs/stash@{0}', author: 'E2E Author', email: 'author@example.com', date: NOW - 600, message: 'WIP on main: 0000001 Fix #12' },
		{ hash: 'b'.repeat(40), baseHash: 'f'.repeat(40), untrackedFilesHash: 'c'.repeat(40), selector: 'refs/stash@{1}', author: 'E2E Author', email: 'author@example.com', date: NOW - 7200, message: 'On feature: Experiment' }
	];

	/* Fixture Data */

	const makeCommits = (count) => {
		const commits = [];
		for (let i = 0; i < count; i++) {
			commits.push({
				hash: hash(i + 1),
				parents: i < count - 1 ? [hash(i + 2)] : [],
				author: i % 3 === 1 ? 'Second Author' : 'E2E Author',
				email: i % 3 === 1 ? 'second@example.com' : 'author@example.com',
				date: NOW - i * 3600,
				message: i === 0 ? 'Fix #12 and rename files' : (i % 2 === 0 ? 'Resolve #' + (100 + i) : 'Commit ' + i),
				heads: i === 0 ? ['feature'] : i === HEAD_INDEX ? ['main'] : [],
				tags: [],
				remotes: [],
				stash: null
			});
		}
		return commits;
	};

	const respond = (msg) => {
		switch (msg.command) {
			case 'loadRepoInfo':
				return { command: 'loadRepoInfo', refreshId: msg.refreshId, branches: ['feature', 'main'], head: 'main', remotes: ['origin'], stashes: STASHES, upstreams: { main: { name: 'origin/main', ahead: 2, behind: 1, gone: false } }, isRepo: true, error: null };
			case 'loadCommits':
				if (msg.filePath === 'src/new-name.ts') {
					// The history of src/new-name.ts: every 5th commit (with the parents rewritten by Git), renamed from src/old-name.ts in the oldest commit
					const history = makeCommits(25).filter((_, i) => i % 5 === 0);
					history.forEach((commit, i) => commit.parents = i < history.length - 1 ? [history[i + 1].hash] : []);
					const commits = {};
					history.forEach((commit, i) => commits[commit.hash] = { filePath: 'src/new-name.ts', oldFilePath: i === history.length - 1 ? 'src/old-name.ts' : null, additions: i + 1, deletions: i });
					return { command: 'loadCommits', refreshId: msg.refreshId, commits: history, head: hash(HEAD_INDEX + 1), tags: [], moreCommitsAvailable: false, onlyFollowFirstParent: msg.onlyFollowFirstParent, fileHistory: { filePath: msg.filePath, paths: ['src/new-name.ts', 'src/old-name.ts'], commits: commits }, error: null };
				}
				// HEAD is the 20th commit, which isn't included in the first load of 10 commits
				return msg.maxCommits <= 10
					? { command: 'loadCommits', refreshId: msg.refreshId, commits: makeCommits(10), head: hash(HEAD_INDEX + 1), tags: [], moreCommitsAvailable: true, onlyFollowFirstParent: msg.onlyFollowFirstParent, error: null }
					: { command: 'loadCommits', refreshId: msg.refreshId, commits: makeCommits(25), head: hash(HEAD_INDEX + 1), tags: [], moreCommitsAvailable: false, onlyFollowFirstParent: msg.onlyFollowFirstParent, error: null };
			case 'loadConfig':
				return {
					command: 'loadConfig', repo: msg.repo, error: null,
					config: {
						branches: {}, diffTool: null, guiDiffTool: null, pushDefault: null,
						remotes: [{ name: 'origin', url: 'git@github.com:e2e-owner/e2e-repo.git', pushUrl: null }],
						user: { name: { local: null, global: 'E2E Author' }, email: { local: null, global: 'author@example.com' } }
					}
				};
			case 'commitDetails':
				return {
					command: 'commitDetails', avatar: null, codeReview: null, refresh: msg.refresh, error: null,
					commitDetails: {
						hash: msg.commitHash, parents: [hash(2)],
						author: 'E2E Author', authorEmail: 'author@example.com', authorDate: NOW,
						committer: 'E2E Author', committerEmail: 'author@example.com', committerDate: NOW,
						signature: null, body: 'Fix #12 and rename files',
						fileChanges: [
							{ oldFilePath: 'src/old-name.ts', newFilePath: 'src/new-name.ts', type: 'R', additions: 1, deletions: 1 },
							{ oldFilePath: 'lib/moved.ts', newFilePath: 'src/moved.ts', type: 'R', additions: 0, deletions: 0 },
							{ oldFilePath: 'README.md', newFilePath: 'README.md', type: 'M', additions: 2, deletions: 1 }
						]
					}
				};
			case 'loadFileDiff':
				return { command: 'loadFileDiff', commitHash: msg.commitHash, filePath: msg.newFilePath, error: null, diff: 'diff --git a/' + msg.oldFilePath + ' b/' + msg.newFilePath + '\n--- a/' + msg.oldFilePath + '\n+++ b/' + msg.newFilePath + '\n@@ -1,3 +1,3 @@\n line 1\n-line <2>\n+line <two>\n line 3\n' };
			case 'loadStashStats':
				return { command: 'loadStashStats', error: null, stats: Object.fromEntries(msg.stashes.map((stash) => [stash.hash, stash.hash === STASHES[0].hash ? { files: 3, additions: 46, deletions: 8, untrackedFiles: 0 } : { files: 2, additions: 5, deletions: 0, untrackedFiles: 1 }])) };
			case 'loadFileIconTheme':
				// A file icon theme with a font icon for Markdown files, and a default icon for other files
				return {
					command: 'loadFileIconTheme',
					theme: {
						id: 'e2e', fonts: [], light: null, highContrast: null,
						definitions: { '_md': { fontCharacter: 'M', fontColor: '#123456', fontId: null, fontSize: null, iconPath: null }, '_file': { fontCharacter: 'F', fontColor: null, fontId: null, fontSize: null, iconPath: null } },
						file: '_file', folder: null, folderExpanded: null, fileExtensions: { 'md': '_md' }, fileNames: {}, folderNames: {}, folderNamesExpanded: {}
					}
				};
			case 'searchCommits':
				// The commits that change a file whose path contains "README" are the even commits
				return { command: 'searchCommits', id: msg.id, error: null, hashes: msg.files.some((file) => 'readme.md'.includes(file.toLowerCase())) ? makeCommits(25).filter((_, i) => i % 2 === 0).map((commit) => commit.hash) : [] };
			case 'openExternalUrl':
			case 'setGlobalViewState':
			case 'setWorkspaceViewState':
				return { command: msg.command, error: null };
			default:
				return null;
		}
	};

	const fakeApi = {
		postMessage: (msg) => {
			requests.push(msg);
			const response = respond(msg);
			if (response !== null) setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: response })), 0);
		},
		getState: () => null,
		setState: () => { }
	};
	globalThis.acquireVsCodeApi = () => fakeApi;

	// Load the fixture repository, with Issue Linking configured to use a custom URL scheme
	const repoState = Object.assign({}, initialState.repos[Object.keys(initialState.repos)[0]], { issueLinkingConfig: { issue: '#(\\d+)', url: ISSUE_URL }, name: null });
	initialState.repos = { [REPO]: repoState };
	initialState.loadViewTo = { repo: REPO };
	initialState.lastActiveRepo = REPO;
	initialState.config.fetchAvatars = false;
	initialState.config.initialLoadCommits = 10;
	initialState.config.loadMoreCommits = 15;
	initialState.config.onRepoLoad = Object.assign({}, initialState.config.onRepoLoad, { scrollToHead: false });

	/* Helpers */

	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const waitFor = async (description, condition, timeout = 5000) => {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			const value = condition();
			if (value) return value;
			await sleep(25);
		}
		throw new Error('Timed out waiting for ' + description);
	};
	const assert = (condition, message) => {
		if (!condition) throw new Error(message);
	};
	const key = (target, k, modifiers) => {
		const event = new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, modifiers || {}));
		target.dispatchEvent(event);
		return event;
	};
	const mouse = (target, type, init) => {
		const bounds = target.getBoundingClientRect();
		const event = new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, clientX: Math.round(bounds.left + Math.min(bounds.width / 2, 50)), clientY: Math.round(bounds.top + bounds.height / 2) }, init || {}));
		target.dispatchEvent(event);
		return event;
	};
	const requestsOf = (command) => requests.filter((msg) => msg.command === command);
	const commitRow = (index) => document.querySelector('#commitTable tr.commit[data-id="' + index + '"]');
	const isMac = navigator.platform.toUpperCase().indexOf('MAC') > -1;
	const ctrl = isMac ? { metaKey: true } : { ctrlKey: true };
	const results = [];
	const check = async (id, title, fn) => {
		try {
			results.push({ id: id, title: title, pass: true, details: (await fn()) || '' });
		} catch (err) {
			results.push({ id: id, title: title, pass: false, details: err && err.stack ? err.stack : String(err) });
		}
	};

	/* Checks */

	// Run when the Git Map View is displayed in Simplified Chinese (git-graph.language)
	const runL10n = async () => {
		await waitFor('the commits to be rendered', () => document.querySelectorAll('#commitTable tr.commit').length === 10, 10000);

		await check('l10n-view', 'The control bar, column headers, dates & tooltips are displayed in Simplified Chinese', async () => {
			assert(document.documentElement.lang === 'zh-CN', 'Unexpected lang: ' + document.documentElement.lang);
			const controls = document.getElementById('controls').textContent, labels = Array.from(document.querySelectorAll('#controls .dropdownLabel')).map((elem) => elem.textContent);
			assert(JSON.stringify(labels) === JSON.stringify(['仓库', '分支', '作者']), 'Unexpected dropdown labels: ' + JSON.stringify(labels));
			['显示远程分支', '提取', '拉取', '推送'].forEach((text) => assert(controls.includes(text), 'The control bar doesn\'t include "' + text + '": ' + controls));
			const headers = Array.from(document.querySelectorAll('#tableColHeaders th')).map((elem) => elem.textContent.trim());
			assert(JSON.stringify(headers) === JSON.stringify(['图形', '说明', '日期', '作者', '提交']), 'Unexpected column headers: ' + JSON.stringify(headers));
			const date = commitRow(0).querySelector('.dateCol');
			assert(/^\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/.test(date.textContent), 'Unexpected date: ' + date.textContent);
			assert(date.title.includes('年'), 'Unexpected date tooltip: ' + date.title);
			assert(document.getElementById('findBtn').title === '查找', 'Unexpected Find tooltip: ' + document.getElementById('findBtn').title);
			return 'Columns: ' + headers.join(' | ') + ', date: ' + date.textContent;
		});

		await check('l10n-menu-dialog', 'Context menus and dialogs are displayed in Simplified Chinese', async () => {
			const openContextMenu = async (target) => {
				mouse(target, 'contextmenu', { button: 2 });
				const items = await waitFor('the context menu to open', () => {
					const elems = document.querySelectorAll('.contextMenu .contextMenuItem');
					return elems.length > 0 ? Array.from(elems) : null;
				});
				const untranslated = items.filter((elem) => !/[一-鿿]/.test(elem.textContent));
				assert(untranslated.length === 0, 'Untranslated context menu items: ' + untranslated.map((elem) => elem.textContent).join(' | '));
				return items;
			};
			const branchItems = await openContextMenu(commitRow(0).querySelector('.gitRef.head'));
			key(document.body, 'Escape');
			await waitFor('the context menu to close', () => document.querySelector('.contextMenu') === null);

			const items = await openContextMenu(commitRow(1));
			const createBranchItem = items.find((elem) => elem.textContent.startsWith('创建分支'));
			assert(createBranchItem, 'Unexpected context menu: ' + items.map((elem) => elem.textContent).join(' | '));
			mouse(createBranchItem, 'click');
			const dialogElem = await waitFor('the dialog to open', () => document.querySelector('.dialog'));
			const action = document.getElementById('dialogAction').textContent, cancel = document.getElementById('dialogSecondaryAction').textContent;
			assert(dialogElem.textContent.includes('上创建分支：') && action === '创建分支' && cancel === '取消', 'Unexpected dialog: ' + dialogElem.textContent);
			key(document.body, 'Escape');
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);
			return 'Commit context menu: ' + items.map((elem) => elem.textContent).join(' | ') + '; branch context menu: ' + branchItems.length + ' items; dialog buttons: ' + action + ' / ' + cancel;
		});

		await check('l10n-cdv', 'The Commit Details View and the Authors dropdown are displayed in Simplified Chinese', async () => {
			mouse(commitRow(0), 'click');
			const cdv = await waitFor('the Commit Details View to load', () => document.querySelector('#cdv .fileTreeFileRecord') ? document.getElementById('cdv') : null);
			['提交：', '父提交：', '作者：', '提交者：', '日期：'].forEach((text) => assert(cdv.textContent.includes(text), 'The Commit Details View doesn\'t include "' + text + '"'));
			const actions = Array.from(cdv.querySelectorAll('#cdvActions .cdvActionBtn')).map((elem) => elem.textContent);
			assert(actions[0] === '签出…' && actions[1] === '创建分支…' && actions[2] === '拣选…', 'Unexpected action buttons: ' + JSON.stringify(actions));
			assert(document.querySelector('#minimap .minimapTitle').textContent === '活动', 'Unexpected minimap title: ' + document.querySelector('#minimap .minimapTitle').textContent);
			const dropdown = document.getElementById('authorDropdown');
			mouse(dropdown.querySelector('.dropdownCurrentValue'), 'click');
			const options = await waitFor('the author options', () => {
				const elems = dropdown.querySelectorAll('.dropdownOption');
				return elems.length > 0 ? Array.from(elems).map((elem) => elem.textContent.trim()) : null;
			});
			assert(options[0] === '全部', 'Unexpected author options: ' + JSON.stringify(options));
			key(document.body, 'Escape');
			return 'Author options: ' + options.join(', ');
		});

		await check('l10n-settings', 'The Repository Settings Widget and its dialogs are displayed in Simplified Chinese', async () => {
			mouse(document.getElementById('settingsBtn'), 'click');
			const widget = await waitFor('the Repository Settings Widget to load', () => document.getElementById('editIssueLinking') ? document.getElementById('settingsWidget') : null);
			const sections = Array.from(widget.querySelectorAll('h3, h4')).map((elem) => elem.textContent.trim());
			['外观 · 所有仓库', '界面语言 · 所有仓库', '状态栏 · 所有仓库', '此仓库', 'Issue 链接', '远程仓库', '常规', '用户信息', '拉取请求创建'].forEach((text) => assert(sections.includes(text), 'Unexpected sections: ' + JSON.stringify(sections)));
			assert(widget.querySelector('#settingsHeader h2').textContent === '设置', 'Unexpected title: ' + widget.querySelector('#settingsHeader h2').textContent);
			mouse(document.getElementById('editIssueLinking'), 'click');
			await waitFor('the Issue Linking dialog', () => document.getElementById('dialogInput1'));
			const action = document.getElementById('dialogAction').textContent, cancel = document.getElementById('dialogSecondaryAction').textContent;
			assert(action === '保存' && cancel === '取消', 'Unexpected dialog buttons: ' + action + ' / ' + cancel);
			key(document.body, 'Escape');
			return 'Sections: ' + sections.join(', ') + '; Issue Linking dialog buttons: ' + action + ' / ' + cancel;
		});
	};

	const run = async () => {
		if (initialState.l10n !== null) return runL10n();
		const keybindings = initialState.config.keybindings;
		await waitFor('the commits to be rendered', () => document.querySelectorAll('#commitTable tr.commit').length === 10, 10000);

		await check('#857', '"Scroll to HEAD" loads more commits until HEAD is loaded', async () => {
			const loads = requestsOf('loadCommits').length;
			key(document.body, keybindings.scrollToHead, ctrl);
			await waitFor('more commits to be requested', () => requestsOf('loadCommits').length > loads);
			await waitFor('the HEAD commit to be scrolled to', () => commitRow(HEAD_INDEX) !== null && commitRow(HEAD_INDEX).classList.contains('flash'));
			return 'Requested maxCommits ' + requestsOf('loadCommits').map((msg) => msg.maxCommits).join(' → ');
		});

		await check('#892', 'The second keypress of a keybinding chord (e.g. Ctrl+K Ctrl+H) is left to Visual Studio Code', async () => {
			key(document.body, 'k', ctrl);
			const chordEvent = key(document.body, keybindings.find, ctrl);
			assert(!chordEvent.defaultPrevented, 'Git Map handled the second keypress of the chord');
			assert(!document.querySelector('.findWidget').classList.contains('active'), 'The Find Widget was opened by the second keypress of the chord');
			const event = key(document.body, keybindings.find, ctrl);
			assert(event.defaultPrevented, 'Git Map didn\'t handle its own keybinding outside of a chord');
			await waitFor('the Find Widget to open', () => document.querySelector('.findWidget').classList.contains('active'));
			key(document.getElementById('findInput'), 'Escape');
			await waitFor('the Find Widget to close', () => !document.querySelector('.findWidget').classList.contains('active'));
		});

		await check('#928', 'Tooltips are shown for elements with a title (e.g. the (i) icons)', async () => {
			const findBtn = document.getElementById('findBtn');
			let tooltip = null;
			for (let attempt = 1; attempt <= 3 && tooltip === null; attempt++) {
				// Retried, as real mouse / focus events (the Visual Studio Code window is on screen) can hide a pending tooltip
				mouse(findBtn, 'mouseover');
				assert(!findBtn.hasAttribute('title'), 'The title attribute should be removed while hovering, so the native tooltip isn\'t also shown');
				tooltip = await waitFor('the tooltip to be shown', () => document.getElementById('titleTooltip'), 1500).catch(() => null);
			}
			assert(tooltip !== null, 'The tooltip wasn\'t shown');
			assert(tooltip.textContent === 'Find', 'Unexpected tooltip: ' + tooltip.textContent);
			mouse(document.getElementById('commitTable'), 'mouseover');
			assert(document.getElementById('titleTooltip') === null, 'The tooltip wasn\'t hidden');
			assert(findBtn.getAttribute('title') === 'Find', 'The title attribute wasn\'t restored');
		});

		await check('#852', 'The mouse back / forward buttons navigate the editor history', async () => {
			mouse(document.getElementById('view'), 'mouseup', { button: 3 });
			mouse(document.getElementById('view'), 'mouseup', { button: 4 });
			const navigations = requestsOf('navigateEditorHistory').map((msg) => msg.forward);
			assert(navigations.length === 2 && navigations[0] === false && navigations[1] === true, 'Unexpected navigation requests: ' + JSON.stringify(navigations));
		});

		// Open the Commit Details View of the first commit
		mouse(commitRow(0), 'click');
		await waitFor('the Commit Details View to load', () => document.querySelector('#cdv .fileTreeFileRecord'));

		await check('#723', 'Renamed files show their original name in the Commit Details View', async () => {
			const labels = Array.from(document.querySelectorAll('#cdv .gitFileRenamedFrom')).map((elem) => elem.textContent);
			assert(labels.length === 2 && labels.includes('← old-name.ts') && labels.includes('← lib/moved.ts'), 'Unexpected labels: ' + JSON.stringify(labels));
			return labels.join(', ');
		});

		await check('#792', 'Issue links using a custom URL scheme are opened (via the extension)', async () => {
			const link = await waitFor('the issue link', () => Array.from(document.querySelectorAll('#cdv a.externalUrl')).find((elem) => elem.getAttribute('href').startsWith('gitgraph-e2e:')));
			// If Git Map doesn't handle the click, prevent the Webview from navigating to the link (which would unload this harness)
			let reachedSafetyNet = false, preventedBeforeSafetyNet = false;
			const safetyNet = (e) => {
				reachedSafetyNet = true;
				preventedBeforeSafetyNet = e.defaultPrevented;
				e.preventDefault();
			};
			window.addEventListener('click', safetyNet);
			const event = mouse(link, 'click');
			window.removeEventListener('click', safetyNet);
			assert(reachedSafetyNet ? preventedBeforeSafetyNet : event.defaultPrevented, 'The click wasn\'t handled');
			const opened = requestsOf('openExternalUrl').map((msg) => msg.url);
			assert(opened.length === 1 && opened[0] === 'gitgraph-e2e://issue/12', 'Unexpected URLs opened: ' + JSON.stringify(opened));
			return 'Opened ' + opened[0];
		});

		await check('#864', 'The Menu key / Shift+F10 opens the context menu of the commit selected with the keyboard', async () => {
			const view = document.getElementById('view');
			view.focus();
			mouse(view, 'contextmenu', { button: 0 });
			const menu = await waitFor('the context menu to open', () => document.querySelector('.contextMenu'));
			assert(menu.textContent.includes('Create Branch'), 'Unexpected context menu: ' + menu.textContent);
			assert(commitRow(0).classList.contains('contextMenuActive'), 'The context menu isn\'t for the selected commit');
			key(document.body, 'Escape');
			await waitFor('the context menu to close', () => document.querySelector('.contextMenu') === null);
		});

		await check('ui-toolbar', '[Redesign] The control bar is sticky, has its labels inside the dropdowns, and a Jump to HEAD button', async () => {
			const controls = document.getElementById('controls');
			assert(getComputedStyle(controls).position === 'sticky', 'The controls aren\'t sticky: ' + getComputedStyle(controls).position);
			const labels = Array.from(document.querySelectorAll('#controls .dropdownLabel')).map((elem) => elem.textContent);
			assert(JSON.stringify(labels) === JSON.stringify(['Repo', 'Branches', 'Authors']), 'Unexpected dropdown labels: ' + JSON.stringify(labels));
			const headBtn = document.getElementById('scrollToHeadBtn');
			assert(headBtn !== null && headBtn.querySelector('svg') !== null && headBtn.getAttribute('title') === 'Scroll to HEAD' && headBtn.textContent === 'HEAD', 'The Jump to HEAD button is missing');

			// The Pull & Push buttons show how many commits the current branch (main) is behind / ahead of its upstream (origin/main)
			const pullBtn = document.getElementById('pullBtn'), pushBtn = document.getElementById('pushBtn');
			assert(pullBtn.textContent === 'Pull1' && pushBtn.textContent === 'Push2' && pushBtn.classList.contains('pending'), 'Unexpected sync buttons: ' + pullBtn.textContent + ' / ' + pushBtn.textContent);
			mouse(pushBtn, 'click');
			const pushDialog = await waitFor('the Push Branch dialog', () => document.querySelector('.dialog'));
			assert(pushDialog.textContent.includes('push the branch main'), 'Unexpected Push dialog: ' + pushDialog.textContent);
			key(document.body, 'Escape');
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);
			mouse(pullBtn, 'click');
			const pullDialog = await waitFor('the Pull dialog', () => document.querySelector('.dialog'));
			assert(pullDialog.textContent.includes('pull the remote branch origin/main into main'), 'Unexpected Pull dialog: ' + pullDialog.textContent);
			key(document.body, 'Escape');
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);
			mouse(document.querySelector('#branchDropdown .dropdownLabel'), 'click');
			await waitFor('the Branches dropdown to open when its label is clicked', () => document.getElementById('branchDropdown').classList.contains('dropdownOpen'));
			mouse(controls, 'click');
			await waitFor('the Branches dropdown to close', () => !document.getElementById('branchDropdown').classList.contains('dropdownOpen'));
			return 'Labels: ' + labels.join(', ') + '; sync: ' + pullBtn.textContent + ', ' + pushBtn.textContent;
		});

		await check('ui-cdv', '[Redesign] The Commit Details View is docked to the right, with buttons for the most common commit actions', async () => {
			mouse(commitRow(3), 'click');
			await waitFor('the Commit Details View of the commit to load', () => document.querySelector('#cdv .fileTreeFileRecord') && document.querySelector('#cdvActions .cdvActionBtn') && commitRow(3).classList.contains('commitDetailsOpen'));
			const cdv = document.getElementById('cdv');
			assert(cdv.classList.contains('docked') && cdv.classList.contains('right') && document.body.classList.contains('cdvDockedRight'), 'The Commit Details View isn\'t docked to the right: ' + cdv.className);
			assert(cdv.style.width !== '' && document.getElementById('view').style.right === cdv.style.width, 'The view isn\'t beside the Commit Details View: ' + document.getElementById('view').style.right + ' / ' + cdv.style.width);
			const buttons = Array.from(document.querySelectorAll('#cdvActions .cdvActionBtn')).map((elem) => elem.textContent);
			assert(JSON.stringify(buttons) === JSON.stringify(['Checkout\u2026', 'Create Branch\u2026', 'Cherry Pick\u2026', '\u00b7\u00b7\u00b7']), 'Unexpected action buttons: ' + JSON.stringify(buttons));
			mouse(document.getElementById('cdvMoreActions'), 'click');
			const menu = await waitFor('the commit context menu to open', () => document.querySelector('.contextMenu'));
			assert(menu.textContent.includes('Revert') && menu.textContent.includes('Copy Commit Hash to Clipboard'), 'Unexpected context menu: ' + menu.textContent);
			key(document.body, 'Escape');
			await waitFor('the context menu to close', () => document.querySelector('.contextMenu') === null);
			return 'Width: ' + cdv.style.width + ', actions: ' + buttons.join(' | ');
		});

		await check('ui-cdv-panel', '[Redesign] The Commit Details View has a header with previous / next buttons, chips to copy the hash / open on the remote / compare, the branches containing the commit, and tabs of the changed files & commit message', async () => {
			const title = document.querySelector('#cdvHeader .cdvHeaderTitle');
			assert(title !== null && title.textContent === 'Commit Details', 'Unexpected header: ' + (title && title.textContent));
			const chips = Array.from(document.querySelectorAll('#cdvSummary .cdvChip')).map((elem) => elem.textContent);
			assert(JSON.stringify(chips) === JSON.stringify([hash(4).substring(0, 8), 'Open on Remote', 'Compare with\u2026']), 'Unexpected chips: ' + JSON.stringify(chips));
			mouse(document.getElementById('cdvCopyHash'), 'click');
			const copied = requestsOf('copyToClipboard').pop();
			assert(copied && copied.data === hash(4), 'The hash wasn\'t copied: ' + JSON.stringify(copied));
			mouse(document.getElementById('cdvOpenOnRemote'), 'click');
			const opened = requestsOf('openExternalUrl').pop();
			assert(opened && opened.url === 'https://github.com/e2e-owner/e2e-repo/commit/' + hash(4), 'Unexpected URL opened: ' + JSON.stringify(opened));
			const branches = Array.from(document.querySelectorAll('#cdvSummary .cdvBranch')).map((elem) => elem.textContent);
			assert(JSON.stringify(branches) === JSON.stringify(['feature']), 'Unexpected branches: ' + JSON.stringify(branches));
			const stats = document.querySelector('#cdvSummary .cdvStats').textContent;
			assert(stats === '3 files+3\u22122', 'Unexpected stats: ' + stats);
			const badges = Array.from(document.querySelectorAll('#cdvFileView .fileTreeFileRecord')).map((elem) => elem.querySelector('.fileTreeFileBadge').textContent + (elem.querySelector('.changeBar') !== null ? ' bar' : ''));
			assert(badges.length === 3 && badges.every((badge) => badge.endsWith(' bar')) && badges.filter((badge) => badge.startsWith('R')).length === 2, 'Unexpected files: ' + JSON.stringify(badges));
			// The icons of the files are from the file icon theme of Visual Studio Code
			const icons = Array.from(document.querySelectorAll('#cdvFileView .fileTreeFileRecord')).map((elem) => elem.querySelector('.gitFileName').textContent + '=' + elem.querySelector('.fileTypeIcon').textContent).sort();
			assert(JSON.stringify(icons) === JSON.stringify(['README.md=M', 'moved.ts=F', 'new-name.ts=F']), 'Unexpected file icons: ' + JSON.stringify(icons));
			const readmeIcon = Array.from(document.querySelectorAll('#cdvFileView .fileTypeIcon')).find((elem) => elem.textContent === 'M');
			assert(getComputedStyle(readmeIcon).color === 'rgb(18, 52, 86)', 'The colour of the icon isn\'t from the theme: ' + getComputedStyle(readmeIcon).color);

			mouse(document.querySelector('.cdvTab[data-tab="message"]'), 'click');
			const messageView = document.getElementById('cdvMessageView');
			assert(!messageView.classList.contains('hidden') && document.getElementById('cdvFileView').classList.contains('hidden') && messageView.textContent.includes('Commit:'), 'The Commit Message tab wasn\'t shown');
			mouse(document.querySelector('.cdvTab[data-tab="files"]'), 'click');
			assert(messageView.classList.contains('hidden') && !document.getElementById('cdvFileView').classList.contains('hidden'), 'The Changed Files tab wasn\'t shown');

			mouse(document.getElementById('cdvNext'), 'click');
			await waitFor('the next commit to be loaded', () => commitRow(4).classList.contains('commitDetailsOpen') && document.querySelector('#cdv .fileTreeFileRecord'));
			mouse(document.getElementById('cdvPrev'), 'click');
			await waitFor('the previous commit to be loaded', () => commitRow(3).classList.contains('commitDetailsOpen') && document.getElementById('cdvCompare'));

			mouse(document.getElementById('cdvCompare'), 'click');
			assert(document.getElementById('cdvCompare').classList.contains('active'), 'The Compare chip isn\'t active');
			mouse(commitRow(6), 'click');
			const compare = await waitFor('the commits to be compared', () => requestsOf('compareCommits').pop());
			assert(compare.commitHash === hash(4) && compare.compareWithHash === hash(7), 'Unexpected comparison: ' + JSON.stringify(compare));
			await waitFor('the header to show the comparison', () => document.querySelector('#cdvHeader .cdvHeaderTitle').textContent === 'Commit Comparison');
			mouse(document.getElementById('cdvClose'), 'click');
			await waitFor('the Commit Details View to close', () => document.getElementById('cdv') === null);
			return 'Chips: ' + chips.join(' | ') + '; branches: ' + branches.join(', ') + '; stats: ' + stats + '; files: ' + badges.join(', ') + '; icons: ' + icons.join(', ');
		});

		await check('ui-stash-list', '[Redesign] The Stashes button lists the stashes (with their branch, date & changes), applies / pops / drops them, and goes to them', async () => {
			const stashBtn = document.getElementById('stashBtn');
			assert(!stashBtn.classList.contains('hidden') && stashBtn.textContent === 'Stashes2', 'Unexpected Stashes button: ' + stashBtn.textContent);
			mouse(stashBtn, 'click');
			const list = await waitFor('the list of stashes', () => document.getElementById('stashList'));
			const items = () => Array.from(list.querySelectorAll('.stashListItem'));
			assert(JSON.stringify(items().map((item) => item.querySelector('.stashListSelector').textContent)) === JSON.stringify(['stash@{0}', 'stash@{1}']), 'Unexpected stashes');
			const stats = requestsOf('loadStashStats').pop();
			assert(stats && stats.stashes.length === 2 && stats.stashes[1].untrackedFilesHash === 'c'.repeat(40), 'The stats of the stashes weren\'t requested: ' + JSON.stringify(stats));
			const metas = await waitFor('the stats of the stashes', () => {
				const metas = items().map((item) => item.querySelector('.stashListMeta').textContent);
				return metas.every((meta) => meta.includes(' files · ')) ? metas : null;
			});
			assert(metas[0].startsWith('main') && metas[0].includes('3 files · +46 \u22128') && metas[1].startsWith('feature') && metas[1].includes('Includes untracked files') && metas.every((meta) => meta.includes('Not in the loaded commits')), 'Unexpected stashes: ' + JSON.stringify(metas));
			assert(document.getElementById('stashListStashChanges').classList.contains('disabled'), 'Stashing is possible without uncommitted changes');

			mouse(items()[0].querySelector('.stashListAction[data-action="apply"]'), 'click');
			const applyDialog = await waitFor('the Apply Stash dialog', () => document.querySelector('.dialog'));
			assert(applyDialog.textContent.includes('apply the stash stash@{0}') && document.getElementById('stashList') === null, 'Unexpected Apply Stash dialog: ' + applyDialog.textContent);
			key(document.body, 'Escape');
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);

			mouse(stashBtn, 'click');
			await waitFor('the list of stashes', () => document.getElementById('stashList'));
			mouse(document.querySelectorAll('#stashList .stashListItem')[1].querySelector('.stashListAction[data-action="drop"]'), 'click');
			const dropDialog = await waitFor('the Drop Stash dialog', () => document.querySelector('.dialog'));
			assert(dropDialog.textContent.includes('drop the stash stash@{1}'), 'Unexpected Drop Stash dialog: ' + dropDialog.textContent);
			key(document.body, 'Escape');
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);

			// The stash isn't in the commits (and all commits are loaded), so it can't be gone to
			mouse(stashBtn, 'click');
			await waitFor('the list of stashes', () => document.getElementById('stashList'));
			mouse(document.querySelector('#stashList .stashListMessage'), 'click');
			const message = await waitFor('the message', () => document.querySelector('.dialog'));
			assert(message.textContent.includes('stash@{0} isn\'t in the commits that are currently shown'), 'Unexpected message: ' + message.textContent);
			key(document.body, 'Escape');
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);
			mouse(stashBtn, 'click');
			await waitFor('the list of stashes', () => document.getElementById('stashList'));
			key(document.body, 'Escape');
			await waitFor('the list to close', () => document.getElementById('stashList') === null && !stashBtn.classList.contains('active'));
			return metas.join(' | ');
		});

		await check('ui-branch-highlight', '[GitLens] Hovering over a commit highlights the branch it is on in the graph', async () => {
			const graph = document.querySelector('#commitGraph > svg');
			mouse(commitRow(5), 'mouseover');
			await waitFor('the branch to be highlighted', () => graph.classList.contains('branchHighlight'));
			const highlighted = graph.querySelectorAll('path.line.highlight').length, vertices = graph.querySelectorAll('circle.highlight').length;
			assert(highlighted > 0 && vertices > 0, 'Nothing was highlighted: ' + highlighted + ' lines, ' + vertices + ' vertices');
			mouse(document.getElementById('commitTable'), 'mouseleave');
			await waitFor('the highlight to be removed', () => !graph.classList.contains('branchHighlight'));
			return highlighted + ' line(s) & ' + vertices + ' vertices highlighted';
		});

		await check('ui-minimap', '[GitLens] The minimap shows the activity of the loaded commits, where HEAD & branches are, and the visible commits', async () => {
			const minimap = document.getElementById('minimap');
			assert(minimap.classList.contains('active'), 'The minimap isn\'t shown');
			const bars = Array.from(minimap.querySelectorAll('.minimapBar')), activeBars = bars.filter((bar) => !bar.classList.contains('empty'));
			const loaded = document.querySelectorAll('#commitTable tr.commit').length;
			const counted = activeBars.reduce((sum, bar) => sum + parseInt(bar.getAttribute('title').match(/: (\d+) commits$/)[1]), 0);
			assert(bars.length >= 30 && counted === loaded, 'Unexpected bars: ' + bars.length + ' days, ' + counted + ' of ' + loaded + ' commits');
			assert(minimap.querySelector('.minimapMarker.head') !== null && minimap.querySelector('.minimapMarker.branch') !== null, 'The HEAD & branch markers are missing');
			const viewport = document.getElementById('minimapViewport');
			assert(viewport !== null && viewport.style.width !== '', 'The visible commits aren\'t shown');
			mouse(activeBars[0], 'click');
			await waitFor('the oldest day\'s newest commit to be scrolled to', () => document.querySelector('#commitTable tr.commit.flash') !== null);
			return bars.length + ' days, ' + activeBars.length + ' with commits (' + counted + ' commits)';
		});

		// Open the "Create Branch" dialog from the context menu of a commit
		mouse(commitRow(1), 'contextmenu', { button: 2 });
		const createBranchItem = await waitFor('the "Create Branch..." action', () => Array.from(document.querySelectorAll('.contextMenu .contextMenuItem')).find((elem) => elem.textContent.startsWith('Create Branch')));
		mouse(createBranchItem, 'click');
		const dialogElem = await waitFor('the dialog to open', () => document.querySelector('.dialog'));

		await check('#856', 'Pasting a branch name with the mouse enables the "Create Branch" button', async () => {
			assert(dialogElem.classList.contains('noInput'), 'The dialog should initially indicate that no name was entered');
			const input = document.getElementById('dialogInput0');
			input.value = 'feature/pasted-with-the-mouse';
			input.dispatchEvent(new Event('input', { bubbles: true })); // Pasting with the context menu triggers an input event (no key events)
			assert(!dialogElem.classList.contains('noInput'), 'The "Create Branch" button is still disabled');
		});

		await check('#652', 'The dialog buttons can be focused with Tab (after the inputs), and activated with Enter', async () => {
			const inputTabIndexes = Array.from(dialogElem.querySelectorAll('input, .customSelectCurrent')).map((elem) => elem.tabIndex);
			const actionButton = document.getElementById('dialogAction'), cancelButton = document.getElementById('dialogSecondaryAction');
			assert(actionButton.tabIndex > Math.max.apply(null, inputTabIndexes) && cancelButton.tabIndex > actionButton.tabIndex, 'Unexpected tab order: inputs ' + JSON.stringify(inputTabIndexes) + ', buttons ' + actionButton.tabIndex + ', ' + cancelButton.tabIndex);
			cancelButton.focus();
			assert(document.activeElement === cancelButton, 'The Cancel button can\'t be focused');
			key(cancelButton, 'Enter');
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);
			assert(requestsOf('createBranch').length === 0, 'Enter on the Cancel button created the branch');
			return 'Tab order: inputs ' + inputTabIndexes.join(', ') + ' → buttons ' + actionButton.tabIndex + ', ' + cancelButton.tabIndex;
		});

		await check('#707', 'Adding Issue Linking prefills the Issue URL of the repository\'s GitHub remote (not an example URL)', async () => {
			if (document.querySelector('.dialog') !== null) {
				key(document.body, 'Escape'); // Close any dialog left open by a previous (failed) check
				await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);
			}
			const loadedCommits = document.querySelectorAll('#commitTable tr.commit').length;
			mouse(document.getElementById('settingsBtn'), 'click');
			mouse(await waitFor('the "Remove" Issue Linking button', () => document.getElementById('removeIssueLinking')), 'click');
			mouse(await waitFor('the confirmation', () => document.getElementById('dialogAction')), 'click');
			// Removing the Issue Linking hard refreshes the view, wait for the commits to be reloaded (they're used to detect the Issue Regex)
			await waitFor('the commits to be reloaded', () => document.querySelectorAll('#commitTable tr.commit').length === loadedCommits);
			const addButton = await waitFor('the "Add Issue Linking" button', () => {
				const elem = document.getElementById('editIssueLinking');
				return elem !== null && elem.classList.contains('addBtn') ? elem : null;
			});
			mouse(addButton, 'click');
			const issueUrlInput = await waitFor('the Issue Linking dialog', () => document.getElementById('dialogInput1'));
			const issueRegex = document.getElementById('dialogInput0').value;
			assert(issueRegex === '#(\\d+)', 'Unexpected Issue Regex: ' + issueRegex);
			assert(issueUrlInput.value === 'https://github.com/e2e-owner/e2e-repo/issues/$1', 'Unexpected Issue URL: ' + issueUrlInput.value);
			assert(!document.querySelector('.dialog').textContent.includes('mhutchie'), 'The dialog still refers to the original author\'s repository');
			key(document.body, 'Escape');
			return 'Prefilled: ' + issueRegex + ' → ' + issueUrlInput.value;
		});

		await check('#171', 'Commits can be filtered by selecting authors in the Authors dropdown', async () => {
			if (document.querySelector('.dialog') !== null) {
				key(document.body, 'Escape');
				await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);
			}
			assert(requestsOf('loadCommits').every((msg) => msg.authors === null), 'Commits were filtered by author before an author was selected');
			const dropdown = document.getElementById('authorDropdown');
			const findOption = (name) => Array.from(dropdown.querySelectorAll('.dropdownOption')).find((elem) => elem.textContent.trim() === name);
			mouse(dropdown.querySelector('.dropdownCurrentValue'), 'click');
			const options = await waitFor('the author options', () => findOption('Second Author') && findOption('E2E Author') ? Array.from(dropdown.querySelectorAll('.dropdownOption')).map((elem) => elem.textContent.trim()) : null);

			const loads = requestsOf('loadCommits').length;
			mouse(findOption('Second Author'), 'click');
			const filtered = await waitFor('the commits of the selected author to be requested', () => requestsOf('loadCommits').slice(loads).find((msg) => msg.authors !== null));
			assert(JSON.stringify(filtered.authors) === '["Second Author"]', 'Unexpected authors: ' + JSON.stringify(filtered.authors));

			mouse(findOption('Show All'), 'click');
			await waitFor('the commits of all authors to be requested', () => requestsOf('loadCommits').slice(-1)[0].authors === null);
			key(document.body, 'Escape');
			return 'Options: ' + options.join(', ') + ' → requested authors ' + JSON.stringify(filtered.authors);
		});

		await check('ui-file-history', '[Redesign] The history of a file (opened by the extension) shows the commits that change it, how they change it, its renames, and its changes in a commit (with a diff)', async () => {
			const rows = () => document.querySelectorAll('#commitTable tr.commit');
			window.dispatchEvent(new MessageEvent('message', { data: { command: 'loadRepos', repos: initialState.repos, lastActiveRepo: REPO, loadViewTo: { repo: REPO, fileHistory: 'src/new-name.ts' } } }));
			await waitFor('the history of the file to be loaded', () => requestsOf('loadCommits').slice(-1)[0].filePath === 'src/new-name.ts' && rows().length === 5);
			const bar = document.getElementById('fileHistoryBar');
			assert(bar.classList.contains('active') && bar.textContent.includes('File History') && bar.textContent.includes('src/new-name.ts') && bar.textContent.includes('5 commits') && bar.textContent.includes('followed 1 rename'), 'Unexpected File History bar: ' + bar.textContent);
			assert(document.querySelector('#tableColHeaders .fileChangesCol').textContent === 'Changes to this File', 'The Changes to this File column is missing');
			const changes = Array.from(rows()).map((row) => row.querySelector('td.fileChangesCol').textContent);
			assert(JSON.stringify(changes) === JSON.stringify(['+1\u22120', '+2\u22121', '+3\u22122', '+4\u22123', '+5\u22124']), 'Unexpected changes: ' + JSON.stringify(changes));
			assert(rows()[4].querySelector('.fileHistoryRenamed').textContent.includes('Renamed from src/old-name.ts'), 'The rename isn\'t shown');
			const columns = new Set(Array.from(document.querySelectorAll('#commitGraph svg circle')).map((circle) => circle.getAttribute('cx')));
			assert(columns.size === 1, 'The graph of the history isn\'t connected');

			// Only the history on the current branch can be shown (which is also selected in the Branches dropdown)
			mouse(document.querySelector('.fileHistoryBranchesOption[data-value="current"]'), 'click');
			await waitFor('the history on the current branch to be loaded', () => JSON.stringify(requestsOf('loadCommits').slice(-1)[0].branches) === JSON.stringify(['main']) && requestsOf('loadCommits').slice(-1)[0].filePath === 'src/new-name.ts' && rows().length === 5);
			const branchValue = document.querySelector('#branchDropdown .dropdownValue').textContent;
			assert(branchValue === 'main' && document.querySelector('.fileHistoryBranchesOption[data-value="current"]').classList.contains('active'), 'The current branch isn\'t selected: ' + branchValue);
			mouse(document.querySelector('.fileHistoryBranchesOption[data-value="all"]'), 'click');
			await waitFor('the history on all branches to be loaded', () => requestsOf('loadCommits').slice(-1)[0].branches === null && rows().length === 5);

			mouse(rows()[1], 'click');
			await waitFor('the changes to the file in the commit', () => document.getElementById('cdvFileFocus') && document.querySelector('#cdvFileDiff .cdvFileDiffLine'));
			assert(document.querySelector('#cdvHeader .cdvHeaderTitle').textContent === 'Changes to this File in the Commit', 'Unexpected title: ' + document.querySelector('#cdvHeader .cdvHeaderTitle').textContent);
			const diffRequest = requestsOf('loadFileDiff').pop();
			assert(diffRequest.commitHash === hash(6) && diffRequest.oldFilePath === 'src/old-name.ts' && diffRequest.newFilePath === 'src/new-name.ts' && diffRequest.parentHash === hash(2), 'Unexpected diff request: ' + JSON.stringify(diffRequest));
			const lines = Array.from(document.querySelectorAll('#cdvFileDiff .cdvFileDiffLine')).map((line) => line.className.split(' ')[1] + ':' + line.lastElementChild.textContent);
			assert(JSON.stringify(lines) === JSON.stringify(['context:line 1', 'del:line <2>', 'add:line <two>', 'context:line 3']), 'Unexpected diff: ' + JSON.stringify(lines));
			mouse(document.getElementById('cdvFileFocusDiff'), 'click');
			const viewDiff = await waitFor('the diff to be opened', () => requestsOf('viewDiff').pop());
			assert(viewDiff.newFilePath === 'src/new-name.ts' && viewDiff.oldFilePath === 'src/old-name.ts', 'Unexpected diff opened: ' + JSON.stringify(viewDiff));
			mouse(document.getElementById('cdvFileFocusAll'), 'click');
			await waitFor('the whole commit to be shown', () => document.getElementById('cdvFileFocus') === null && document.querySelector('#cdvHeader .cdvHeaderTitle').textContent === 'Commit Details');
			mouse(document.getElementById('cdvClose'), 'click');
			await waitFor('the Commit Details View to close', () => document.getElementById('cdv') === null);

			mouse(document.getElementById('fileHistoryExit'), 'click');
			await waitFor('all of the commits to be loaded', () => requestsOf('loadCommits').slice(-1)[0].filePath === null && rows().length === 10 && !bar.classList.contains('active') && document.querySelector('#tableColHeaders .fileChangesCol') === null);
			return changes.length + ' commits: ' + changes.join(', ') + '; diff: ' + lines.length + ' lines';
		});

		await check('ui-settings-panel', '[Redesign] The Repository Settings panel changes the colour preset, line style, language & Status Bar Item for all repositories', async () => {
			if (document.querySelector('.dialog') !== null) {
				key(document.body, 'Escape');
				await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);
			}
			if (!document.getElementById('settingsWidget').classList.contains('active')) mouse(document.getElementById('settingsBtn'), 'click');
			const widget = await waitFor('the Repository Settings panel to load', () => document.querySelector('#settingsWidget.active .settingsPreset') ? document.getElementById('settingsWidget') : null);
			const bounds = widget.getBoundingClientRect();
			assert(Math.round(bounds.right) === window.innerWidth && Math.round(bounds.top) === 0 && Math.round(bounds.bottom) === window.innerHeight, 'The panel isn\'t docked to the right: ' + JSON.stringify(bounds));
			const presets = Array.from(widget.querySelectorAll('.settingsPreset')), selected = presets.filter((elem) => elem.classList.contains('selected'));
			assert(presets.length === 6 && selected.length === 1, 'Unexpected colour presets: ' + presets.length + ' (' + selected.length + ' selected)');
			const updates = () => requestsOf('updateExtensionSetting').map((msg) => msg.key + '=' + msg.value);
			const before = updates().length;
			mouse(presets.find((elem) => elem.dataset.preset === 'Tokyo Subway'), 'click');
			mouse(widget.querySelector('.settingsSegmented[data-setting="graph.style"] .settingsSegment[data-value="angular"]'), 'click');
			mouse(widget.querySelector('.settingsSegmented[data-setting="statusBarItemDisplay"] .settingsSegment[data-value="Icon"]'), 'click');
			const english = Array.from(widget.querySelectorAll('input[name="settingsLanguage"]')).find((elem) => elem.value === 'English');
			english.checked = true;
			english.dispatchEvent(new Event('change', { bubbles: true }));
			const sent = await waitFor('the settings to be sent to the extension', () => updates().length >= before + 4 ? updates().slice(before) : null);
			assert(JSON.stringify(sent) === JSON.stringify(['graph.colourPreset=Tokyo Subway', 'graph.style=angular', 'statusBarItemDisplay=Icon', 'language=English']), 'Unexpected updates: ' + JSON.stringify(sent));
			assert(document.querySelector('.settingsStatusBarPreview svg') !== null && !document.querySelector('.settingsStatusBarPreview').textContent.includes('Git Map'), 'The Status Bar Item preview wasn\'t updated');
			mouse(document.getElementById('settingsClose'), 'click');
			await waitFor('the panel to close', () => !document.getElementById('settingsWidget').classList.contains('active'));
			return 'Sent: ' + sent.join(', ');
		});

		await check('ui-find-operators', '[GitLens] The Find Widget supports the author:, message: & commit: search operators, shown alongside the scrollbar', async () => {
			await waitFor('the commits to be reloaded', () => document.querySelectorAll('#commitTable tr.commit').length > 0 && requestsOf('loadCommits').slice(-1)[0].authors === null);
			const loaded = document.querySelectorAll('#commitTable tr.commit').length, fixture = makeCommits(loaded);
			const find = async (text) => {
				const input = document.getElementById('findInput');
				input.value = text;
				input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
				const expected = text === '' ? '' : null;
				return waitFor('the matches of ' + text, () => {
					const position = document.getElementById('findPosition').textContent;
					return position !== '' && document.getElementById('findInput').value === text && !document.querySelector('.findWidget').hasAttribute('data-error') ? position : expected;
				});
			};
			document.getElementById('findBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await waitFor('the Find Widget to open', () => document.querySelector('.findWidget').classList.contains('active'));
			const results = {};
			const expect = async (text, count) => {
				const position = await find(text);
				await sleep(300);
				const actual = document.getElementById('findPosition').textContent;
				assert(actual === (count > 0 ? '1 of ' + count : 'No Results'), 'Unexpected matches of ' + text + ': ' + actual + ' (expected ' + count + ')');
				results[text] = actual;
			};
			await expect('author:"Second Author" Commit', fixture.filter((c) => c.author === 'Second Author' && c.message.includes('Commit')).length);
			await expect('@:second', fixture.filter((c) => c.author === 'Second Author').length);
			await expect('message:Resolve =:#10', fixture.filter((c) => c.message.includes('Resolve') && c.message.includes('#10')).length);
			await expect('commit:' + hash(5), 1);
			const view = document.getElementById('view'), markers = document.querySelectorAll('#scrollMarkers .scrollMarker.findMatch').length;
			assert(view.scrollHeight <= view.clientHeight || markers === 1, 'The find match isn\'t shown alongside the scrollbar: ' + markers + ' markers');
			mouse(document.getElementById('findClose'), 'click');
			await waitFor('the Find Widget to close', () => !document.querySelector('.findWidget').classList.contains('active'));
			return JSON.stringify(results) + (view.scrollHeight > view.clientHeight ? ', scrollbar markers shown' : ', the view isn\'t scrollable (no scrollbar markers)');
		});

		await check('ui-find-filter', '[Redesign] The search box adds conditions as chips, can only show the matching commits (keeping the graph connected), and searches the files changed by the commits (file:)', async () => {
			const rows = () => document.querySelectorAll('#commitTable tr.commit').length, total = rows(), fixture = makeCommits(total);
			const countText = (count) => count !== 1 ? count + ' commits match' : '1 commit matches';
			const input = document.getElementById('findInput');
			input.focus();
			input.value = 'author:"Second Author"';
			key(input, 'Enter');
			assert(document.querySelectorAll('#findChips .findChip').length === 1 && input.value === '', 'The condition wasn\'t added as a chip');
			const expected = fixture.filter((commit) => commit.author === 'Second Author').length;
			await waitFor('the matches to be counted', () => document.getElementById('findCount').textContent === countText(expected));

			mouse(document.querySelector('.findMode[data-mode="filter"]'), 'click');
			await waitFor('only the matching commits to be shown', () => rows() === expected);
			const columns = new Set(Array.from(document.querySelectorAll('#commitGraph svg circle')).map((circle) => circle.getAttribute('cx')));
			assert(columns.size === 1, 'The graph of the matching commits isn\'t connected (' + columns.size + ' columns)');

			input.value = '?:README';
			input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'E' }));
			const search = await waitFor('the files changed by the commits to be searched', () => requestsOf('searchCommits').pop());
			assert(JSON.stringify(search.files) === JSON.stringify(['README']) && search.changes.length === 0, 'Unexpected search: ' + JSON.stringify(search));
			const both = fixture.filter((commit, i) => commit.author === 'Second Author' && i % 2 === 0).length;
			await waitFor('the commits matching both conditions to be shown', () => rows() === both && document.getElementById('findCount').textContent === countText(both))
				.catch((err) => { throw new Error(err.message + ' (' + rows() + ' rows, "' + document.getElementById('findCount').textContent + '", expected ' + both + ')'); });

			mouse(document.getElementById('findClear'), 'click');
			await waitFor('all of the commits to be shown again', () => rows() === total && !document.querySelector('.findWidget').classList.contains('active'));
			assert(document.querySelectorAll('#findChips .findChip').length === 0, 'The chips weren\'t cleared');
			return expected + ' commit(s) by Second Author (' + columns.size + ' graph column), ' + both + ' also changing README, of ' + total;
		});
	};

	window.addEventListener('load', () => {
		setTimeout(() => {
			run().catch((err) => {
				results.push({ id: 'webview-harness', title: 'The Webview UI harness ran', pass: false, details: err && err.stack ? err.stack : String(err) });
			}).then(() => {
				realApi.postMessage({ command: 'e2eResults', results: results });
			});
		}, 0);
	});
})();
